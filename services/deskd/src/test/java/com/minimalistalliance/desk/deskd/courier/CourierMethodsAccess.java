package com.minimalistalliance.desk.deskd.courier;

import com.minimalistalliance.desk.deskd.courier.vault.LinkedAccounts;
import com.minimalistalliance.desk.deskd.rpc.RpcException;

/** Tests in other packages reach {@link CourierMethods}' package-private wording through this. */
public final class CourierMethodsAccess {

    private CourierMethodsAccess() {}

    /** A transport's refusal word as the office gets it. */
    public static RpcException rejected(String word, String providerName) {
        return CourierMethods.rejected(new LinkedAccounts.Rejected(word), providerName);
    }
}
