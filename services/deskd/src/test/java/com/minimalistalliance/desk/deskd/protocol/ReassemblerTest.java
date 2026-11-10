package com.minimalistalliance.desk.deskd.protocol;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class ReassemblerTest {

    private final ReassemblyBudget budget = new ReassemblyBudget(ReassemblyBudget.DEFAULT_BYTES);
    private final Reassembler reassembler = new Reassembler(budget);

    private static Frame fragment(FrameKind kind, long id, boolean more, int bytes) {
        return new Frame(kind, more ? Frame.MORE : 0, id, 0, new byte[bytes]);
    }

    private static byte[] pattern(int bytes) {
        byte[] payload = new byte[bytes];
        for (int i = 0; i < bytes; i++) {
            payload[i] = (byte) (i % 251);
        }
        return payload;
    }

    private Message feedAll(List<byte[]> frames) throws Exception {
        Message result = null;
        for (byte[] frame : frames) {
            assertThat(result).isNull();
            result = reassembler.accept(Frame.decode(frame));
        }
        return result;
    }

    @Test
    void oneFrameMessageNeedsNoBuffer() throws Exception {
        Message message = reassembler.accept(new Frame(FrameKind.REQ, 0, 7, 0, new byte[] {1, 2, 3}));
        assertThat(message.payload()).containsExactly(1, 2, 3);
        assertThat(message.id()).isEqualTo(7);
        assertThat(budget.used()).isZero();
    }

    @Test
    void fragmentThenReassembleGivesTheSameBytes() throws Exception {
        byte[] payload = pattern(100_000);
        List<byte[]> frames = Frame.fragment(FrameKind.RES, 0, 3, 0, payload);
        assertThat(frames).hasSize(7);
        for (byte[] frame : frames) {
            assertThat(frame.length).isLessThanOrEqualTo(Frame.MAX_FRAME_BYTES);
        }
        assertThat(feedAll(frames).payload()).isEqualTo(payload);
        assertThat(budget.used()).isZero();
    }

    @Test
    void moreIsOnEveryFrameButTheLastAndEndOnlyOnTheLast() throws Exception {
        List<byte[]> frames = Frame.fragment(FrameKind.CHUNK, Frame.BIN | Frame.END, 1, 4, pattern(40_000));
        assertThat(frames).hasSize(3);
        for (int i = 0; i < frames.size(); i++) {
            Frame frame = Frame.decode(frames.get(i));
            boolean last = i == frames.size() - 1;
            assertThat(frame.flags() & Frame.BIN).isEqualTo(Frame.BIN);
            assertThat(frame.more()).isEqualTo(!last);
            assertThat((frame.flags() & Frame.END) != 0).isEqualTo(last);
            assertThat(frame.seq()).isEqualTo(4);
        }
    }

    @Test
    void aShortResponseOvertakesALongOne() throws Exception {
        byte[] longPayload = pattern(50_000);
        List<byte[]> longFrames = Frame.fragment(FrameKind.RES, 0, 1, 0, longPayload);
        List<Message> completed = new ArrayList<>();

        addIfComplete(completed, reassembler.accept(Frame.decode(longFrames.get(0))));
        addIfComplete(completed, reassembler.accept(new Frame(FrameKind.RES, 0, 2, 0, "short".getBytes())));
        for (byte[] frame : longFrames.subList(1, longFrames.size())) {
            addIfComplete(completed, reassembler.accept(Frame.decode(frame)));
        }

        assertThat(completed).extracting(Message::id).containsExactly(2L, 1L);
        assertThat(completed.get(0).payload()).isEqualTo("short".getBytes());
        assertThat(completed.get(1).payload()).isEqualTo(longPayload);
    }

    private static void addIfComplete(List<Message> completed, Message message) {
        if (message != null) {
            completed.add(message);
        }
    }

    @Test
    void theSameIdOnTwoKindsIsTwoMessages() throws Exception {
        assertThat(reassembler.accept(fragment(FrameKind.REQ, 5, true, 10))).isNull();
        assertThat(reassembler.accept(fragment(FrameKind.SUB, 5, true, 20))).isNull();
        assertThat(reassembler.accept(fragment(FrameKind.REQ, 5, false, 1)).payload()).hasSize(11);
        assertThat(reassembler.accept(fragment(FrameKind.SUB, 5, false, 2)).payload()).hasSize(22);
    }

    @Test
    void aFragmentThatContradictsItsMessageIsAProtocolError() throws Exception {
        reassembler.accept(new Frame(FrameKind.REQ, Frame.MORE, 5, 0, new byte[10]));
        assertThatThrownBy(() -> reassembler.accept(new Frame(FrameKind.REQ, Frame.BIN, 5, 0, new byte[1])))
                .isInstanceOf(FrameException.class);
        assertThatThrownBy(() -> reassembler.accept(new Frame(FrameKind.REQ, 0, 5, 9, new byte[1])))
                .isInstanceOf(FrameException.class);
    }

    private void assertLimit(FrameKind kind, int limit) throws Exception {
        Message atLimit = feedAll(Frame.fragment(kind, 0, 1, 0, new byte[limit]));
        assertThat(atLimit.payload()).hasSize(limit);

        List<byte[]> over = Frame.fragment(kind, 0, 2, 0, new byte[limit + 1]);
        assertThatThrownBy(() -> {
                    for (byte[] frame : over) {
                        reassembler.accept(Frame.decode(frame));
                    }
                })
                .isInstanceOfSatisfying(TooLargeException.class, e -> {
                    assertThat(e.recoverable()).isTrue();
                    assertThat(e.id()).isEqualTo(2);
                    assertThat(e.kind()).isEqualTo(kind);
                });
    }

    @Test
    void reqLimitIsOneMebibyte() throws Exception {
        assertLimit(FrameKind.REQ, 1024 * 1024);
    }

    @Test
    void resLimitIsOneMebibyte() throws Exception {
        assertLimit(FrameKind.RES, 1024 * 1024);
    }

    @Test
    void evtLimitIs64Kibibytes() throws Exception {
        assertLimit(FrameKind.EVT, 64 * 1024);
    }

    @Test
    void dataLimitIsFourMebibytes() throws Exception {
        assertLimit(FrameKind.DATA, 4 * 1024 * 1024);
    }

    @Test
    void anOverLimitMessageKeepsDroppingUntilItsLastFrameAndHoldsNoBytes() throws Exception {
        int frames = (FrameKind.EVT.maxMessageBytes() / Frame.MAX_PAYLOAD_BYTES) + 1;
        byte[] full = new byte[Frame.MAX_PAYLOAD_BYTES];
        for (int i = 0; i < frames - 1; i++) {
            assertThat(reassembler.accept(new Frame(FrameKind.EVT, Frame.MORE, 1, 0, full))).isNull();
        }
        assertThatThrownBy(() -> reassembler.accept(new Frame(FrameKind.EVT, Frame.MORE, 1, 0, full)))
                .isInstanceOf(TooLargeException.class);
        assertThat(budget.used()).isZero();

        assertThat(reassembler.accept(new Frame(FrameKind.EVT, Frame.MORE, 1, 0, full))).isNull();
        assertThat(reassembler.accept(new Frame(FrameKind.EVT, 0, 1, 0, full))).isNull();
        assertThat(budget.used()).isZero();

        // The id is free again.
        assertThat(reassembler.accept(new Frame(FrameKind.EVT, 0, 1, 0, new byte[3])).payload()).hasSize(3);
    }

    @Test
    void tooManyIncompleteMessagesIsFatal() throws Exception {
        for (int id = 0; id < Reassembler.MAX_INCOMPLETE; id++) {
            reassembler.accept(fragment(FrameKind.REQ, id, true, 1));
        }
        assertThatThrownBy(() -> reassembler.accept(fragment(FrameKind.REQ, 999, true, 1)))
                .isInstanceOfSatisfying(TooLargeException.class, e -> assertThat(e.recoverable()).isFalse());
    }

    @Test
    void theBudgetIsSharedAcrossChannelsAndRunningOutIsFatal() throws Exception {
        ReassemblyBudget small = new ReassemblyBudget(40_000);
        Reassembler rpc = new Reassembler(small);
        Reassembler bulk = new Reassembler(small);
        rpc.accept(fragment(FrameKind.REQ, 1, true, 16_000));
        bulk.accept(fragment(FrameKind.DATA, 1, true, 16_000));
        assertThat(small.used()).isEqualTo(32_000);

        assertThatThrownBy(() -> bulk.accept(fragment(FrameKind.DATA, 2, true, 16_000)))
                .isInstanceOfSatisfying(TooLargeException.class, e -> assertThat(e.recoverable()).isFalse());
        assertThat(small.used()).isEqualTo(32_000);
    }

    @Test
    void oneByteFragmentsCantOutgrowTheLimit() throws Exception {
        int limit = FrameKind.SUB.maxMessageBytes();
        for (int i = 0; i < limit; i++) {
            assertThat(reassembler.accept(fragment(FrameKind.SUB, 1, true, 1))).isNull();
        }
        assertThat(budget.used()).isEqualTo(limit);
        assertThatThrownBy(() -> reassembler.accept(fragment(FrameKind.SUB, 1, true, 1)))
                .isInstanceOf(TooLargeException.class);
        assertThat(budget.used()).isZero();
    }
}
