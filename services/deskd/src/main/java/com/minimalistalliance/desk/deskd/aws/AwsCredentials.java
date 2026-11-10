package com.minimalistalliance.desk.deskd.aws;

import java.time.Instant;

/**
 * Temporary role credentials. {@link #toString} leaves out everything secret, so one can't reach a
 * log by accident.
 *
 * @param sessionToken null for long-lived keys, which only the signature test vectors use
 */
public record AwsCredentials(String accessKeyId, String secretAccessKey, String sessionToken, Instant expiration) {

    @Override
    public String toString() {
        return "AwsCredentials[expiration=" + expiration + "]";
    }
}
