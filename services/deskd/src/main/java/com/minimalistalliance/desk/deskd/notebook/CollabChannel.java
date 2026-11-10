package com.minimalistalliance.desk.deskd.notebook;

import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Message;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import com.minimalistalliance.desk.deskd.session.ChannelHandler;
import com.minimalistalliance.desk.deskd.session.Session;

/**
 * Channel 3, {@code collab}: one virtual WebSocket per session, each binary message of it one DATA with BIN set. A
 * session checks nothing about scope on a module's channels, so this does: an {@code export} session's DATA is dropped
 * here, before it can open anything. Non-BIN DATA and any other kind from a client mean nothing here, and are dropped
 * too.
 */
final class CollabChannel implements ChannelHandler {

    private final NotebookLinks links;

    CollabChannel(NotebookLinks links) {
        this.links = links;
    }

    @Override
    public void onMessage(Session session, Message message) throws InterruptedException {
        String scope = session.grant().scope();
        if (message.kind() != FrameKind.DATA || !message.binary()
                || !(RpcPrincipal.OWNER.equals(scope) || RpcPrincipal.GUILD_MEMBER.equals(scope))) {
            return;
        }
        NotebookLink link = links.open(session.sessionId());
        if (link != null) {
            link.collab(message.payload());
        }
    }
}
