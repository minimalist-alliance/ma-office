package com.minimalistalliance.desk.deskd.browser.minified;

/**
 * One of the member's tabs as the Browser knew it at one moment.
 *
 * @param tabId the tab, as {@code browser.tabs} names it
 * @param sessionId deskd's session on it: scripts deskd adds on a session go with that session
 * @param url as cleaned for clients
 * @param title as the page set it, cleaned for clients
 * @param mainFrameId the main frame
 * @param loaderId the main frame's document, or null if no commit has been seen since deskd attached
 */
public record TabRef(String tabId, String sessionId, String url, String title, String mainFrameId, String loaderId) {}
