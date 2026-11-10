package com.minimalistalliance.desk.deskd.browser.minified;

import java.util.Map;
import java.util.Set;

/** What the Browser tells the simplified view of. Every method runs on the read path, so none may block or call Chromium. */
public interface TabEvents {

    /**
     * One event, in order.
     *
     * @param sessionId the session it came on, which may be a frame's session that the Browser doesn't know
     * @param tabId the member's tab whose session that is, or null
     */
    void onEvent(String method, String sessionId, String tabId, Map<String, Object> params);

    /** The tab is gone. */
    void onTabGone(String tabId);

    /** The connection to Chromium is gone, and every session with it. */
    void onDisconnected();

    /**
     * A new connection's tabs, as Chromium lists them: any other tab is gone, closed while there was no connection to say
     * so, or with a Chromium that restarted.
     */
    void onTabsNow(Set<String> tabIds);
}
