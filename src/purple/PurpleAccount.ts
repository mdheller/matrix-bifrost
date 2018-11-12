/**
 * An interface for storing account data inside the userstore.
 */

import { helper, plugins, buddy, accounts, messaging, Buddy, Account } from "node-purple";
import { PurpleProtocol } from "./PurpleInstance";
import { ChatJoinProperties } from "./PurpleEvents";

export class PurpleAccount {
    private acctData: Account | undefined;
    private enabled: boolean;
    constructor(private username: string, public readonly protocol: PurpleProtocol) {
        this.enabled = false;
    }

    get name(): string { return this.acctData!.username; }

    get handle(): External { return this.acctData!.handle; }

    get isEnabled(): boolean { return this.enabled; }

    get connected(): boolean {
        if (!this.acctData) {
            return false;
        }
        return accounts.is_connected(this.acctData.handle);
    }

    public findAccount() {
        const data = accounts.find(this.username, this._protocol.id);
        if (!data) {
            throw new Error("Account not found");
        }
        this.acctData = data;
        this.enabled = accounts.get_enabled(this.acctData.handle);
    }

    public createNew() {
        accounts.new(this.username, this._protocol.id);
    }

    public setEnabled(enable: boolean) {
        if (!this.handle) {
            throw Error("No account is binded to this instance. Call findAccount()");
        }
        accounts.set_enabled(this.acctData!.handle, enable);
    }

    public sendIM(recipient: string, body: string) {
        if (!this.handle) {
            throw Error("No account is binded to this instance. Call findAccount()");
        }
        messaging.sendIM(this.acctData!.handle, recipient, body);
    }

    public getBuddy(user: string): Buddy {
        if (!this.handle) {
            throw Error("No account is binded to this instance. Call findAccount()");
        }
        return buddy.find(this.acctData!.handle, user);
    }

    public joinChat(components: ChatJoinProperties) {
        messaging.joinChat(this.handle, components);
    }

    public rejectChat(components: ChatJoinProperties) {
        messaging.rejectChat(this.handle, components);
    }

    // connect() {
    //     accounts.connect(this.username, this.protocol.id);
    // }
}
