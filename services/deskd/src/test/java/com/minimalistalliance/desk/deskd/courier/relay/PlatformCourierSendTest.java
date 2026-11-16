package com.minimalistalliance.desk.deskd.courier.relay;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.courier.testkit.FakeRelay;
import com.minimalistalliance.desk.deskd.aws.RoleCredentials;
import com.minimalistalliance.desk.deskd.imds.ImdsClient;
import com.minimalistalliance.desk.deskd.platform.AgentClient;
import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.testing.FakePlatform;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.time.Clock;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * {@code courier-send} as contract 0.4.1 has it, signed, against the test kit's fake door: a message up to 4 MiB goes
 * inside the call; a larger one (a 5 MB message with its attachments) goes up through {@code /v1/agent/courier/uploads}
 * and a presigned PUT first, then is sent by its upload id, byte for byte.
 */
class PlatformCourierSendTest {

    private FakePlatform platform;
    private PlatformHttp http;
    private FakeRelay relay;
    private PlatformCourierSend send;
    private String address;

    @BeforeEach
    void setUp() throws Exception {
        platform = new FakePlatform();
        http = new PlatformHttp();
        relay = FakeRelay.start();
        relay.addDesk("desk-s", FakePlatform.ACCESS_KEY);
        address = relay.assignAddress("desk-s", "sender", false);
        AgentClient client = new AgentClient(http, new RoleCredentials(new ImdsClient(http, platform.url()), Clock.systemUTC()), relay::baseUrl,
                Clock.systemUTC());
        PlatformRelayApi api = new PlatformRelayApi(client, http, true);
        send = new PlatformCourierSend(client, api::upload, () -> true);
    }

    @AfterEach
    void tearDown() {
        relay.close();
        http.close();
        platform.close();
    }

    private static byte[] message(int size) {
        byte[] head = "From: sender@courier.example\r\nTo: rowan@example.com\r\nSubject: Plans\r\n\r\n".getBytes(StandardCharsets.US_ASCII);
        byte[] raw = new byte[size];
        new SecureRandom().nextBytes(raw);
        System.arraycopy(head, 0, raw, 0, head.length);
        return raw;
    }

    private CourierSend.Submission submission(byte[] raw, String key) {
        return new CourierSend.Submission(address, List.of("rowan@example.com"), "m1@courier.example", raw, key);
    }

    @Test
    void aFiveMegabyteMessageGoesThroughAnUpload() throws Exception {
        byte[] raw = message(5_000_000);
        CourierSend.Accepted a = send.submit(submission(raw, "send-five-megabytes-1"));

        assertThat(a.accepted()).containsExactly("rowan@example.com");
        assertThat(relay.uploadsMade()).isEqualTo(1);
        assertThat(relay.uploadsHeld()).as("the door deletes an upload it sent").isZero();
        assertThat(relay.mailSent()).hasSize(1);
        assertThat(relay.mailSent().get(0).raw()).isEqualTo(raw);
        // Reserved, PUT, then sent by its id: the message never rode inside the send's JSON.
        List<FakeRelay.Seen> calls = relay.seen().stream().filter(s -> !s.path().startsWith("/v1/agent/courier-addresses")).toList();
        assertThat(calls).extracting(s -> s.method() + " " + s.path().replaceAll("up-[0-9A-Z]{26}", "up-…"))
                .containsExactly("POST /v1/agent/courier/uploads", "PUT /fake-s3/out/desk-s/up-…", "POST /v1/agent/courier/send");
        String sendBody = new String(calls.get(2).body(), StandardCharsets.UTF_8);
        assertThat(sendBody).contains("\"upload\":\"up-").doesNotContain("\"raw\"");
        assertThat(calls.get(2).body().length).isLessThan(1_000);
    }

    @Test
    void fourMebibytesStillGoInline() throws Exception {
        byte[] raw = message(PlatformCourierSend.INLINE_MAX);
        assertThat(PlatformCourierSend.INLINE_MAX).isEqualTo(4 * 1024 * 1024).isEqualTo(FakeRelay.MAIL_INLINE_MAX);
        send.submit(submission(raw, "send-four-mebibytes-1"));
        assertThat(relay.uploadsMade()).isZero();
        assertThat(relay.mailSent().get(0).raw()).isEqualTo(raw);

        // One byte more and it goes up first.
        byte[] more = message(PlatformCourierSend.INLINE_MAX + 1);
        send.submit(submission(more, "send-four-mebibytes-2"));
        assertThat(relay.uploadsMade()).isEqualTo(1);
        assertThat(relay.mailSent().get(1).raw()).isEqualTo(more);
    }

    @Test
    void anUploadThatExpiredIsMadeAgainOnce() throws Exception {
        relay.loseNextUploads(1);
        byte[] raw = message(5_000_000);
        send.submit(submission(raw, "send-lost-upload-1"));
        assertThat(relay.uploadsMade()).isEqualTo(2);
        assertThat(relay.mailSent()).hasSize(1);
        assertThat(relay.mailSent().get(0).raw()).isEqualTo(raw);

        // Twice in a row is the door's answer, said as it is.
        relay.loseNextUploads(2);
        assertThatThrownBy(() -> send.submit(submission(message(5_000_000), "send-lost-upload-2")))
                .isInstanceOfSatisfying(RelayApi.Refused.class, r -> assertThat(r.code()).isEqualTo("upload_missing"));
        assertThat(relay.mailSent()).hasSize(1);
    }

    @Test
    void pastTheDoorsLimitNothingIsUploaded() throws Exception {
        assertThatThrownBy(() -> send.submit(submission(message(FakeRelay.MAIL_MAX + 1), "send-too-large-1")))
                .isInstanceOfSatisfying(RelayApi.Refused.class, r -> {
                    assertThat(r.status()).isEqualTo(413);
                    assertThat(r.code()).isEqualTo("too_large");
                });
        assertThat(relay.seen()).noneMatch(s -> s.path().startsWith("/fake-s3/"));
        assertThat(relay.mailSent()).isEmpty();
    }

    @Test
    void aRetriedSendWhoseFirstTryGotThroughIsSentOnce() throws Exception {
        // The answer to the first try is lost; the retry makes a new upload, so its body differs: the door's 422 says the
        // first try went (Senders counts idempotency_key_reused as sent).
        relay.loseNextCourierSendAnswers(1);
        byte[] raw = message(5_000_000);
        assertThatThrownBy(() -> send.submit(submission(raw, "send-retried-once-1")))
                .isInstanceOfSatisfying(RelayApi.Refused.class, r -> assertThat(r.status()).isEqualTo(504));
        assertThatThrownBy(() -> send.submit(submission(raw, "send-retried-once-1")))
                .isInstanceOfSatisfying(RelayApi.Refused.class, r -> assertThat(r.code()).isEqualTo("idempotency_key_reused"));
        assertThat(relay.mailSent()).hasSize(1);
    }
}
