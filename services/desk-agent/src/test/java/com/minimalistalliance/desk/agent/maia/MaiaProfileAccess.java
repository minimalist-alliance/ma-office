package com.minimalistalliance.desk.agent.maia;

/** Tests in other packages read package rules through here. */
public final class MaiaProfileAccess {

    private MaiaProfileAccess() {}

    /** Whether the member's words ask to see something. */
    public static boolean asks(String said) {
        return MaiaProfile.ASKED_TO_SEE.matcher(said).find();
    }
}
