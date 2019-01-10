import { IChatJoinProperties, IUserInfo, IConversationEvent, IChatJoined } from "../purple/PurpleEvents";
import { XmppJsInstance, XMPP_PROTOCOL } from "./XJSInstance";
import { IPurpleAccount, IChatJoinOptions } from "../purple/IPurpleAccount";
import { IPurpleInstance } from "../purple/IPurpleInstance";
import { PurpleProtocol } from "../purple/PurpleProtocol";
import { jid } from "@xmpp/component";
import { Element, x } from "@xmpp/xml";
import { IBasicProtocolMessage } from "../MessageFormatter";
import { Metrics } from "../Metrics";
import { Logging } from "matrix-appservice-bridge";
import * as uuid from "uuid/v4";

const IDPREFIX = "pbridge";
const CONFLICT_SUFFIX = "[m]";
const log = Logging.get("XmppJsAccount");

export class XmppJsAccount implements IPurpleAccount {

    get _waitingJoinRoomProps(): IChatJoinProperties|undefined {
        return undefined;
    }

    get name(): string {
        return this.remoteId;
    }

    get protocol(): PurpleProtocol {
        return XMPP_PROTOCOL;
    }
    public readonly waitingToJoin: Set<string>;
    public readonly isEnabled = true;
    public readonly connected = true;

    private roomHandles: Map<string, string>;
    constructor(public readonly remoteId: string, public readonly resource, private xmpp: XmppJsInstance) {
        this.roomHandles = new Map();
        this.waitingToJoin = new Set();
        this.iqWaiting = new Map();
    }

    public findAccount() {
        // TODO: What do we actually need to find.
    }

    public createNew(password?: string) {
        throw Error("Xmpp.js doesn't support registering accounts");
    }

    public setEnabled(enable: boolean) {
        throw Error("Xmpp.js doesn't allow you to enable or disable accounts");
    }

    public sendIM(recipient: string, msg: IBasicProtocolMessage) {
        const id = IDPREFIX + Date.now().toString();
        const message = x(
            "message",
            {
                to: recipient,
                id,
                from: `${this.remoteId}/${this.resource}`,
                type: "chat",
            },
            x("body", undefined, msg.body),
        );
        this.xmpp.xmppAddSentMessage(id);
        this.xmpp.xmppWriteToStream(message);
        Metrics.remoteCall("xmpp.message.im");
    }

    public sendChat(chatName: string, msg: IBasicProtocolMessage) {
        const id = msg.id || IDPREFIX + Date.now().toString();
        const contents: any[] = [];
        const htmlMsg = (msg.formatted || []).find((f) => f.type === "html");
        let htmlAnchor;
        if (msg.opts && msg.opts.attachments) {
            msg.opts.attachments.forEach((a) => {
                contents.push(
                    x("x", {
                        xmlns: "jabber:x:oob",
                    }, x("url", undefined, a.uri)));
                // *some* XMPP clients expect the URL to be in the body, silly clients...
                msg.body = a.uri;
            });
        } else if (htmlMsg) {
            htmlAnchor = Buffer.from(htmlMsg.body).toString("base64").replace(/\W/g, "a");
            contents.push(x("html", {
                xmlns: "http://jabber.org/protocol/xhtml-im",
            }), htmlAnchor);
        }
        contents.push(x("body", undefined, msg.body));
        let message: string = x(
            "message",
            {
                to: chatName,
                id,
                from: `${this.remoteId}/${this.resource}`,
                type: "groupchat",
            },
            contents,
        ).toString();
        if (htmlMsg) {
            message = message.replace(htmlAnchor, htmlMsg.body);
        }
        this.xmpp.xmppAddSentMessage(id);
        this.xmpp.xmppWriteToStream(message);
        Metrics.remoteCall("xmpp.message.groupchat");
    }

    public getBuddy(user: string): any|undefined {
        // TODO: Not implemented
        return;
    }

    public getJoinPropertyForRoom(roomName: string, key: string): string|undefined {
        // TODO: Not implemented
        return;
    }

    public setJoinPropertiesForRoom(roomName: string, props: IChatJoinProperties) {
        // TODO: Not implemented
    }

    public isInRoom(roomName: string): boolean {
        const handle = this.roomHandles.get(roomName);
        if (!handle) {
            log.debug("isInRoom: no handle set for ", this.remoteId);
            return false;
        }
        const res = this.xmpp.presenceCache.getStatus(roomName + "/" + handle);
        log.debug("isInRoom: Got presence for user:", res, this.remoteId);
        if (!res) {
            return false;
        }
        return res.online;
    }

    public async joinChat(
        components: IChatJoinProperties,
        instance?: IPurpleInstance,
        timeout: number = 5000,
        setWaiting: boolean = true)
        : Promise<IConversationEvent|void> {
            const roomName = `${components.room}@${components.server}`;
            const to = `${roomName}/${components.handle}`;
            const from = `${this.remoteId}/${this.resource}`;
            log.info(`Joining to=${to} from=${from}`);
            const message = x(
                "presence",
                {
                    to,
                    from,
                },
                x ("x", {
                    xmlns: "http://jabber.org/protocol/muc",
                }, x ("history", {
                    maxchars: "0", // No history
                })),
            );
            if (setWaiting) {
                this.waitingToJoin.add(roomName);
            }
            let p: Promise<IChatJoined>|undefined;
            if (instance) {
                p = new Promise((resolve, reject) => {
                    const timer = setTimeout(reject, timeout);
                    const cb = (data: IChatJoined) => {
                        if (data.conv.name === roomName &&
                            data.account.username === this.remoteId) {
                            this.roomHandles.set(roomName, components.handle);
                            clearTimeout(timer);
                            this.xmpp.removeListener("chat-joined", cb);
                            resolve(data);
                        }
                    };
                    this.xmpp.on("chat-joined", cb);
                });
            }
            await this.xmpp.xmppWriteToStream(message);
            Metrics.remoteCall("xmpp.presence.join");
            return p;
    }

    public async xmppRetryJoin(from: jid.JID) {
        log.info("Retrying join for ", from.toString());
        if (from.resource.endsWith(CONFLICT_SUFFIX)) {
            // Kick from the room.
            throw new Error(`A user with the prefix '${CONFLICT_SUFFIX}' already exists, cannot join to room.`);
        }
        return this.joinChat({
            room: from.local,
            server: from.domain,
            handle: `${from.resource}${CONFLICT_SUFFIX}`,
        });
    }

    public async rejectChat(components: IChatJoinProperties) {
        const message = x(
            "presence",
            {
                to: `${components.room}@${components.server}/${components.handle}`,
                from: `${this.remoteId}/${this.resource}`,
                type: "unavailable",
            },
        );
        await this.xmpp.xmppWriteToStream(message);
        Metrics.remoteCall("xmpp.presence.left");
    }

    public getConversation(name: string): any {
        throw Error("getConversation not implemented");
    }

    public getChatParamsForProtocol(): IChatJoinOptions[] {
        return [
            {
                identifier: "server",
                label: "server",
                required: true,
            },
            {
                identifier: "room",
                label: "room",
                required: true,
            },
            {
                identifier: "handle",
                label: "handle",
                required: false,
            },
        ];
    }

    public async getUserInfo(who: string): Promise<IUserInfo> {
        const split = who.split("/");
        const status = this.xmpp.presenceCache.getStatus(who);
        const ui: IUserInfo = {
            Nickname: split.length > 1 ? split[1] : split[0],
            eventName: "meh",
            who,
            account: {
                protocol_id: this.protocol.id,
                username: this.remoteId,
            },
        };
        if (status && status.photoId) {
            ui.Avatar = status.photoId;
        }
        return ui;
    }

    public async getAvatarBuffer(iconPath: string, senderId: string): Promise<Buffer> {
        const toJid = jid(senderId);
        const to = `${toJid.local}@${toJid.domain}`;
        const id = uuid();
        log.info(`Fetching avatar for ${senderId} (hash: ${iconPath})`);
        this.xmpp.xmppWriteToStream(
            x("iq", {
                from: `${this.remoteId}/${this.resource}`,
                to,
                type: "get",
                id,
            }, x("vCard", {xmlns: "vcard-temp"}),
        ));
        Metrics.remoteCall("xmpp.iq.vc2");
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(Error("Timeout")), 5000);
            this.xmpp.once("iq." + id, (stanza: Element) => {
                clearTimeout(timeout);
                const vCard = stanza.getChild("vCard");
                if (vCard) {
                    resolve(Buffer.from(
                        stanza.getChild("photo")!.getChildText("binval")!,
                        "base64"
                    ));
                }
                reject("No vCard given");
            });
        });
    }

}
