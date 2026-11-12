package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.testing.TestTiming;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The age gate in {@link BrowserStream}: every way to a start of {@code desk-browser} stays shut while it's shut, whoever's
 * {@code live} was refused starts as it opens, and a restart for the policy stops Chromium and brings back only one that
 * was up, after a hold and past a failed stop. A restart for the band {@code adult} waits for nobody to use the Browser,
 * or for its next start, with the gate open; and either one owed outlives a restart of deskd.
 */
class AgeGateTest {

    private static final String START_BROWSER = "start desk-browser";
    private static final String STOP_BROWSER = "stop desk-browser";
    private static final String START_STREAM = "start desk-stream";
    private static final String STOP_STREAM = "stop desk-stream";
    /** How long to give something that must not happen. */
    private static final long QUIET_MILLIS = 150;

    static {
        TestTiming.pollFast();
    }

    @TempDir
    Path dir;

    private final List<String> steps = new CopyOnWriteArrayList<>();
    private final List<String> video = new CopyOnWriteArrayList<>();
    private final AtomicBoolean gate = new AtomicBoolean();
    private final AtomicBoolean chromiumUp = new AtomicBoolean();
    private final AtomicBoolean simplifiedInUse = new AtomicBoolean();
    private final AtomicInteger stopFailuresLeft = new AtomicInteger();
    private volatile CountDownLatch holdStep;
    private volatile String heldStep;
    private volatile CountDownLatch stepArrived;
    private long arrival;
    private BrowserStream stream;

    @BeforeEach
    void setUp() {
        stream = stream(dir.resolve("unused"));
    }

    private BrowserStream stream(Path marker) {
        BrowserStream made = new BrowserStream(
                this::runStep,
                (id, view) -> video.add(id + " " + view),
                id -> true,
                () -> {},
                () -> {},
                transition -> {},
                Duration.ofMinutes(5),
                new RefusalMarker(marker),
                chromiumUp::get);
        made.ageGateFrom(gate::get, Duration.ofMillis(30));
        made.restartWaitsFor(simplifiedInUse::get);
        return made;
    }

    private static final String BOOT = "11111111-2222-4333-8444-555555555555";

    /** A stream as a restarted deskd of boot {@link #BOOT} has it, with the owed restarts in its data directory, {@code dir}. */
    private BrowserStream streamWithOwed() {
        return streamWithOwed(BOOT);
    }

    private BrowserStream streamWithOwed(String bootId) {
        BrowserStream made = stream(dir.resolve(RefusalMarker.NAME));
        made.owedFrom(new PolicyRestartMarker(dir, bootId));
        return made;
    }

    private boolean owedFile(String name) {
        return Files.exists(dir.resolve(name), java.nio.file.LinkOption.NOFOLLOW_LINKS);
    }

    /** As an earlier deskd of a boot left it. */
    private void owedBy(String name, String bootId) throws java.io.IOException {
        Files.writeString(dir.resolve(name), bootId + "\n");
    }

    private void goOff(String session) {
        assertThat(set(session, BrowserStream.Level.OFF).join()).isEqualTo(BrowserStream.Level.OFF);
    }

    private void runStep(String verb, String unit) throws UnitException, InterruptedException {
        String step = verb + " " + unit;
        steps.add(step);
        if (step.equals(heldStep)) {
            stepArrived.countDown();
            holdStep.await(10, TimeUnit.SECONDS);
        }
        if (step.equals(STOP_BROWSER) && stopFailuresLeft.getAndUpdate(left -> Math.max(0, left - 1)) > 0) {
            throw new UnitException(unit, UnitException.TIMEOUT, null);
        }
    }

    private void holdNext(String step) {
        holdStep = new CountDownLatch(1);
        stepArrived = new CountDownLatch(1);
        heldStep = step;
    }

    private CompletableFuture<BrowserStream.Level> set(String session, BrowserStream.Level level) {
        return stream.set(session, level, ++arrival);
    }

    private static void assertRefusedAtTheGate(CompletableFuture<BrowserStream.Level> result) {
        assertThat(result).isCompletedExceptionally();
        try {
            result.get();
        } catch (ExecutionException e) {
            assertThat(e.getCause()).isInstanceOfSatisfying(UnitException.class, failure -> assertThat(failure.isAgeBand()).isTrue());
        } catch (InterruptedException e) {
            throw new IllegalStateException(e);
        }
    }

    private void open() {
        gate.set(true);
        stream.ageGateMoved();
    }

    private void goLive(String session) {
        gate.set(true);
        assertThat(set(session, BrowserStream.Level.LIVE).join()).isEqualTo(BrowserStream.Level.LIVE);
        await().until(() -> video.contains(session + " true"));
    }

    private void assertNoStartOfChromium() throws InterruptedException {
        Thread.sleep(QUIET_MILLIS);
        assertThat(steps).doesNotContain(START_BROWSER);
    }

    private long count(String step) {
        return steps.stream().filter(step::equals).count();
    }

    // ---- live

    @Test
    void aLiveWhileShutIsAnsweredAtOnceAndNothingStarts() throws Exception {
        assertRefusedAtTheGate(set("cs-1", BrowserStream.Level.LIVE));
        assertNoStartOfChromium();
        assertThat(steps).isEmpty();
        assertThat(video).isEmpty();
        assertThat(stream.ageGateOpen()).isFalse();
    }

    @Test
    void aLiveStartsAsTheGateOpensWithNoFurtherRequest() {
        assertRefusedAtTheGate(set("cs-1", BrowserStream.Level.LIVE));
        open();
        await().until(() -> video.contains("cs-1 true"));
        assertThat(steps).containsExactly(START_BROWSER, START_STREAM);
        assertThat(stream.level()).isEqualTo(BrowserStream.Level.LIVE);
    }

    @Test
    void askingAgainWhileShutChangesNothingAndStartsOnce() {
        assertRefusedAtTheGate(set("cs-1", BrowserStream.Level.LIVE));
        assertRefusedAtTheGate(set("cs-1", BrowserStream.Level.LIVE));
        open();
        await().until(() -> video.contains("cs-1 true"));
        assertThat(count(START_BROWSER)).isEqualTo(1);
        assertThat(set("cs-1", BrowserStream.Level.LIVE).join()).isEqualTo(BrowserStream.Level.LIVE);
    }

    @Test
    void anOffWhileWaitingMeansNothingStarts() throws Exception {
        assertRefusedAtTheGate(set("cs-1", BrowserStream.Level.LIVE));
        assertThat(set("cs-1", BrowserStream.Level.OFF).join()).isEqualTo(BrowserStream.Level.OFF);
        open();
        assertNoStartOfChromium();
        assertThat(video).doesNotContain("cs-1 true");
    }

    @Test
    void aSessionEndingWhileWaitingMeansNothingStarts() throws Exception {
        assertRefusedAtTheGate(set("cs-1", BrowserStream.Level.LIVE));
        stream.sessionEnded("cs-1");
        open();
        assertNoStartOfChromium();
    }

    @Test
    void warmDoesntStartChromiumSoItIsntGated() throws Exception {
        assertThat(set("cs-1", BrowserStream.Level.WARM).join()).isEqualTo(BrowserStream.Level.WARM);
        assertThat(steps).containsExactly(START_STREAM);
        assertNoStartOfChromium();
    }

    @Test
    void offIsNeverGated() {
        assertThat(set("cs-1", BrowserStream.Level.WARM).join()).isEqualTo(BrowserStream.Level.WARM);
        assertThat(set("cs-1", BrowserStream.Level.OFF).join()).isEqualTo(BrowserStream.Level.OFF);
        assertThat(steps).containsExactly(START_STREAM, STOP_STREAM);
    }

    @Test
    void aLiveStillWaitingWhenTheGateShutsIsAnsweredAndStartsAsItOpens() throws Exception {
        gate.set(true);
        holdNext(START_BROWSER);
        CompletableFuture<BrowserStream.Level> waiting = set("cs-1", BrowserStream.Level.LIVE);
        assertThat(stepArrived.await(5, TimeUnit.SECONDS)).isTrue();

        gate.set(false);
        stream.ageGateMoved();
        assertRefusedAtTheGate(waiting);
        holdStep.countDown();

        heldStep = null;
        open();
        await().until(() -> video.contains("cs-1 true"));
    }

    // ---- the other ways to a start

    @Test
    void aLostChromiumDoesntComeBackWhileShut() throws Exception {
        goLive("cs-1");
        steps.clear();
        gate.set(false);
        stream.browserLost();
        assertNoStartOfChromium();

        open();
        await().until(() -> steps.contains(START_BROWSER));
    }

    @Test
    void aChromiumOffItsPortIsLeftWhereItIsWhileShut() throws Exception {
        goLive("cs-1");
        steps.clear();
        gate.set(false);
        stream.browserDisplaced();
        Thread.sleep(QUIET_MILLIS);
        assertThat(steps).isEmpty();

        // The next look after it opens is what restarts it.
        open();
        stream.browserDisplaced();
        await().until(() -> steps.contains(START_BROWSER));
        assertThat(steps).startsWith(STOP_BROWSER);
    }

    @Test
    void theStartOfARestartOffThePortWaitsIfTheGateShutsAfterItsStop() throws Exception {
        goLive("cs-1");
        steps.clear();
        holdNext(STOP_BROWSER);
        stream.browserDisplaced();
        assertThat(stepArrived.await(5, TimeUnit.SECONDS)).isTrue();
        gate.set(false);
        holdStep.countDown();
        assertNoStartOfChromium();

        open();
        await().until(() -> steps.contains(START_BROWSER));
    }

    @Test
    void aHoldsReleaseDoesntStartChromiumWhileShut() throws Exception {
        goLive("cs-1");
        steps.clear();
        stream.hold().join();
        assertThat(steps).containsExactly(STOP_BROWSER);

        gate.set(false);
        stream.release();
        assertNoStartOfChromium();

        open();
        await().until(() -> steps.contains(START_BROWSER));
    }

    @Test
    void aReleaseWithNobodyViewingStillWaitsAtTheGate() throws Exception {
        gate.set(true);
        chromiumUp.set(true);
        stream.hold().join();
        chromiumUp.set(false);
        gate.set(false);
        stream.release();
        assertNoStartOfChromium();

        open();
        await().until(() -> steps.contains(START_BROWSER));
    }

    @Test
    void aHoldStillStopsChromiumWhileShut() {
        assertThat(stream.hold()).succeedsWithin(Duration.ofSeconds(5));
        assertThat(steps).containsExactly(STOP_BROWSER);
    }

    @Test
    void aLiveRefusedAtTheGateWaitsOutAHoldToo() throws Exception {
        assertRefusedAtTheGate(set("cs-1", BrowserStream.Level.LIVE));
        stream.hold().join();
        open();
        assertNoStartOfChromium();

        stream.release();
        await().until(() -> video.contains("cs-1 true"));
        assertThat(steps).containsExactly(STOP_BROWSER, START_BROWSER, START_STREAM);
    }

    // ---- restarting for the policy

    @Test
    void aRestartStopsAndStartsAChromiumThatWasUp() {
        goLive("cs-1");
        steps.clear();
        stream.restartForPolicy();
        await().until(() -> steps.size() >= 2);
        assertThat(steps).containsExactly(STOP_BROWSER, START_BROWSER);
        await().until(stream::ageGateOpen);
    }

    @Test
    void aRestartGoesByThePortForAChromiumThisProcessDidntStart() {
        gate.set(true);
        chromiumUp.set(true);
        stream.restartForPolicy();
        await().until(() -> steps.size() >= 2);
        assertThat(steps).containsExactly(STOP_BROWSER, START_BROWSER);
    }

    @Test
    void aRestartLeavesAChromiumThatWasDownDown() throws Exception {
        gate.set(true);
        stream.restartForPolicy();
        await().until(() -> steps.contains(STOP_BROWSER));
        assertNoStartOfChromium();
        await().until(stream::ageGateOpen);
    }

    @Test
    void aLiveDuringARestartIsAnsweredAndStartsAfterItsStop() throws Exception {
        gate.set(true);
        holdNext(STOP_BROWSER);
        stream.restartForPolicy();
        assertThat(stepArrived.await(5, TimeUnit.SECONDS)).isTrue();

        assertRefusedAtTheGate(set("cs-1", BrowserStream.Level.LIVE));
        assertThat(stream.ageGateOpen()).isFalse();
        holdStep.countDown();

        await().until(() -> video.contains("cs-1 true"));
        assertThat(steps).containsExactly(STOP_BROWSER, START_BROWSER, START_STREAM);
    }

    @Test
    void aRestartFollowsAStartAlreadyOnItsWayAsThatOneMayHaveReadTheFileTooSoon() throws Exception {
        gate.set(true);
        holdNext(START_BROWSER);
        CompletableFuture<BrowserStream.Level> live = set("cs-1", BrowserStream.Level.LIVE);
        assertThat(stepArrived.await(5, TimeUnit.SECONDS)).isTrue();
        heldStep = null;

        stream.restartForPolicy();
        holdStep.countDown();

        assertThat(live).succeedsWithin(Duration.ofSeconds(5));
        await().until(() -> count(START_BROWSER) == 2);
        assertThat(steps.subList(0, 3)).containsExactly(START_BROWSER, STOP_BROWSER, START_BROWSER);
    }

    @Test
    void aRestartWaitsForAHoldsReleaseAndThenComesBack() throws Exception {
        goLive("cs-1");
        steps.clear();
        stream.hold().join();
        assertThat(steps).containsExactly(STOP_BROWSER);

        stream.restartForPolicy();
        Thread.sleep(QUIET_MILLIS);
        assertThat(steps).containsExactly(STOP_BROWSER);
        assertThat(stream.held()).isTrue();

        stream.release();
        await().until(() -> steps.contains(START_BROWSER));
        // A stop that has nothing to do, as the hold's has done it, and then the start the hold owed.
        assertThat(steps).containsExactly(STOP_BROWSER, STOP_BROWSER, START_BROWSER);
    }

    @Test
    void aFailedStopIsTriedAgainAndNothingStartsMeanwhile() throws Exception {
        goLive("cs-1");
        steps.clear();
        stopFailuresLeft.set(3);
        stream.restartForPolicy();

        await().until(() -> count(STOP_BROWSER) >= 2);
        assertThat(stream.ageGateOpen()).isFalse();
        assertThat(steps).doesNotContain(START_BROWSER);
        assertRefusedAtTheGate(set("cs-2", BrowserStream.Level.LIVE));

        await().until(() -> steps.contains(START_BROWSER));
        assertThat(count(STOP_BROWSER)).isEqualTo(4);
        assertThat(steps.get(steps.size() - 1)).isIn(START_BROWSER, START_STREAM);
        await().until(() -> video.contains("cs-2 true"));
        assertThat(stream.ageGateOpen()).isTrue();
    }

    @Test
    void aRestartGoesEvenWhereAStartWouldBeRefusedAsATeenWithoutABrowserIsSafe() throws Exception {
        Path marker = dir.resolve("refused");
        Files.createFile(marker);
        stream = stream(marker);
        gate.set(true);
        chromiumUp.set(true);
        assertThat(stream.chromiumRefused()).isTrue();
        stream.restartForPolicy();
        await().until(() -> steps.contains(STOP_BROWSER));
        await().until(() -> steps.contains(START_BROWSER));
    }

    // ---- restarting for the band adult

    @Test
    void anUnlockWithNobodyUsingTheBrowserRestartsAChromiumThatWasUpAtOnceWithTheGateOpen() {
        goLive("cs-1");
        goOff("cs-1");
        steps.clear();
        stream.restartWhenUnused();
        await().until(() -> steps.size() >= 2);
        assertThat(steps).containsExactly(STOP_BROWSER, START_BROWSER);
        assertThat(stream.ageGateOpen()).isTrue();
        assertThat(stream.unlockOwed()).isFalse();
    }

    @Test
    void anUnlockWaitsWhileASessionIsLiveAndGoesAsItLeaves() throws Exception {
        goLive("cs-1");
        steps.clear();
        stream.restartWhenUnused();
        Thread.sleep(QUIET_MILLIS);
        assertThat(steps).isEmpty();
        assertThat(stream.unlockOwed()).isTrue();
        assertThat(stream.ageGateOpen()).isTrue();

        stream.sessionEnded("cs-1");
        await().until(() -> steps.contains(START_BROWSER));
        assertThat(steps.stream().filter(s -> s.endsWith("desk-browser")).toList()).containsExactly(STOP_BROWSER, START_BROWSER);
        assertThat(stream.unlockOwed()).isFalse();
    }

    @Test
    void anUnlockWaitsWhileTheSimplifiedViewIsInUse() throws Exception {
        gate.set(true);
        chromiumUp.set(true);
        simplifiedInUse.set(true);
        stream.restartWhenUnused();
        Thread.sleep(QUIET_MILLIS);
        assertThat(steps).isEmpty();

        simplifiedInUse.set(false);
        stream.otherUseEnded();
        await().until(() -> steps.size() >= 2);
        assertThat(steps).containsExactly(STOP_BROWSER, START_BROWSER);
    }

    @Test
    void aLiveDuringAnUnlocksStopIsNeverRefusedAndStartsAfterIt() throws Exception {
        gate.set(true);
        chromiumUp.set(true);
        holdNext(STOP_BROWSER);
        stream.restartWhenUnused();
        assertThat(stepArrived.await(5, TimeUnit.SECONDS)).isTrue();

        CompletableFuture<BrowserStream.Level> live = set("cs-1", BrowserStream.Level.LIVE);
        assertThat(live).isNotCompletedExceptionally();
        assertThat(stream.ageGateOpen()).isTrue();
        holdStep.countDown();

        assertThat(live).succeedsWithin(Duration.ofSeconds(5));
        await().until(() -> video.contains("cs-1 true"));
        assertThat(steps).containsExactly(STOP_BROWSER, START_BROWSER, START_STREAM);
    }

    @Test
    void anUnlockOfAChromiumThatsDownAsksNothing() throws Exception {
        gate.set(true);
        stream.restartWhenUnused();
        await().until(() -> !stream.unlockOwed());
        Thread.sleep(QUIET_MILLIS);
        assertThat(steps).isEmpty();
    }

    @Test
    void anUnlockOfAChromiumThatsDownWithNoStepOfItUnderWayOwesNothing() {
        gate.set(true);
        simplifiedInUse.set(true);
        stream.restartWhenUnused();
        assertThat(stream.unlockOwed()).isFalse();
    }

    @Test
    void aStartOfAChromiumThatWentDownIsTheUnlocksRestart() throws Exception {
        goLive("cs-1");
        simplifiedInUse.set(true);
        stream.restartWhenUnused();
        assertThat(stream.unlockOwed()).isTrue();
        steps.clear();

        // Chromium goes away under the viewer, and its start from down reads the file as it is now.
        stream.browserLost();
        await().until(() -> steps.contains(START_BROWSER));
        await().until(() -> !stream.unlockOwed());
        simplifiedInUse.set(false);
        goOff("cs-1");
        stream.otherUseEnded();
        Thread.sleep(QUIET_MILLIS);
        assertThat(steps).doesNotContain(STOP_BROWSER);
    }

    @Test
    void anUnlockDuringAStartOfChromiumIsOwedAsThatStartMayHaveReadTheFileBefore() throws Exception {
        gate.set(true);
        holdNext(START_BROWSER);
        CompletableFuture<BrowserStream.Level> live = set("cs-1", BrowserStream.Level.LIVE);
        assertThat(stepArrived.await(5, TimeUnit.SECONDS)).isTrue();
        heldStep = null;
        stream.restartWhenUnused();
        assertThat(stream.unlockOwed()).isTrue();
        holdStep.countDown();
        assertThat(live).succeedsWithin(Duration.ofSeconds(5));
        assertThat(stream.unlockOwed()).isTrue();
    }

    @Test
    void aStartOfAChromiumThatsUpLeavesTheUnlockOwed() throws Exception {
        gate.set(true);
        chromiumUp.set(true);
        simplifiedInUse.set(true);
        stream.restartWhenUnused();
        goLive("cs-1");
        assertThat(stream.unlockOwed()).isTrue();
        steps.clear();

        simplifiedInUse.set(false);
        stream.sessionEnded("cs-1");
        await().until(() -> steps.contains(START_BROWSER));
        assertThat(steps.stream().filter(s -> s.endsWith("desk-browser")).toList()).containsExactly(STOP_BROWSER, START_BROWSER);
    }

    @Test
    void aFailedUnlockStopGoesAgainLaterAndTheGateStaysOpen() throws Exception {
        gate.set(true);
        chromiumUp.set(true);
        stopFailuresLeft.set(2);
        stream.restartWhenUnused();
        await().until(() -> count(STOP_BROWSER) >= 1);
        assertThat(stream.ageGateOpen()).isTrue();
        await().until(() -> steps.contains(START_BROWSER));
        assertThat(count(STOP_BROWSER)).isEqualTo(3);
        assertThat(stream.unlockOwed()).isFalse();
    }

    @Test
    void aLockDoesAnOwedUnlocksJob() throws Exception {
        goLive("cs-1");
        steps.clear();
        stream.restartWhenUnused();
        stream.restartForPolicy();
        await().until(() -> steps.contains(START_BROWSER));
        assertThat(stream.unlockOwed()).isFalse();

        stream.sessionEnded("cs-1");
        Thread.sleep(QUIET_MILLIS);
        assertThat(count(STOP_BROWSER)).isEqualTo(1);
    }

    @Test
    void anUnlockWaitsForAHoldWhoseStopDoesItsJob() throws Exception {
        gate.set(true);
        chromiumUp.set(true);
        simplifiedInUse.set(true);
        stream.restartWhenUnused();
        stream.hold().join();
        assertThat(stream.unlockOwed()).isFalse();
        simplifiedInUse.set(false);
        stream.release();
        await().until(() -> steps.contains(START_BROWSER));
        assertThat(steps).containsExactly(STOP_BROWSER, START_BROWSER);
    }

    // ---- what's owed outlives a restart of deskd

    @Test
    void anUnlockOwedWhenDeskdStopsGoesWithTheNextDeskd() throws Exception {
        stream = streamWithOwed();
        goLive("cs-1");
        stream.restartWhenUnused();
        assertThat(owedFile(PolicyRestartMarker.UNLOCK)).isTrue();
        assertThat(Files.readString(dir.resolve(PolicyRestartMarker.UNLOCK))).isEqualTo(BOOT + "\n");
        assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(dir.resolve(PolicyRestartMarker.UNLOCK)))).isEqualTo("rw-------");
        assertThat(owedFile(PolicyRestartMarker.LOCK)).isFalse();
        steps.clear();

        // The next deskd: nobody live yet, and Chromium up by its port.
        chromiumUp.set(true);
        stream = streamWithOwed();
        assertThat(stream.ageGateOpen()).isTrue();
        await().until(() -> steps.size() >= 2);
        assertThat(steps).containsExactly(STOP_BROWSER, START_BROWSER);
        await().until(() -> !owedFile(PolicyRestartMarker.UNLOCK));
    }

    @Test
    void aLockOwedIsOnDiskUntilItsStopHasWorked() throws Exception {
        stream = streamWithOwed();
        goLive("cs-1");
        steps.clear();
        holdNext(STOP_BROWSER);
        stream.restartForPolicy();
        assertThat(stepArrived.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(owedFile(PolicyRestartMarker.LOCK)).isTrue();

        holdStep.countDown();
        await().until(() -> steps.contains(START_BROWSER));
        await().until(() -> !owedFile(PolicyRestartMarker.LOCK));
    }

    @Test
    void aLockOwedByAnEarlierDeskdGoesAtOnceWithTheGateShutUntilItsStopHasWorked() throws Exception {
        owedBy(PolicyRestartMarker.LOCK, BOOT);
        gate.set(true);
        chromiumUp.set(true);
        holdNext(STOP_BROWSER);
        stream = streamWithOwed();
        assertThat(stepArrived.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(stream.ageGateOpen()).isFalse();
        assertRefusedAtTheGate(set("cs-1", BrowserStream.Level.LIVE));

        holdStep.countDown();
        await().until(() -> video.contains("cs-1 true"));
        assertThat(steps).containsExactly(STOP_BROWSER, START_BROWSER, START_STREAM);
        assertThat(stream.ageGateOpen()).isTrue();
        await().until(() -> !owedFile(PolicyRestartMarker.LOCK));
    }

    @Test
    void nothingOwedIsNoFileAndNoStep() throws Exception {
        stream = streamWithOwed();
        gate.set(true);
        chromiumUp.set(true);
        Thread.sleep(QUIET_MILLIS);
        assertThat(steps).isEmpty();
        assertThat(owedFile(PolicyRestartMarker.LOCK)).isFalse();
        assertThat(owedFile(PolicyRestartMarker.UNLOCK)).isFalse();
    }

    @Test
    void whatAnotherBootOwedCountsForNothingAndGoes() throws Exception {
        // Before a reboot, which Chromium didn't outlive, or carried here by a restore, a move or an export.
        owedBy(PolicyRestartMarker.LOCK, "99999999-2222-4333-8444-555555555555");
        owedBy(PolicyRestartMarker.UNLOCK, "99999999-2222-4333-8444-555555555555");
        gate.set(true);
        chromiumUp.set(true);
        stream = streamWithOwed();
        Thread.sleep(QUIET_MILLIS);
        assertThat(steps).isEmpty();
        assertThat(stream.ageGateOpen()).isTrue();
        assertThat(owedFile(PolicyRestartMarker.LOCK)).isFalse();
        assertThat(owedFile(PolicyRestartMarker.UNLOCK)).isFalse();
    }

    @Test
    void aLinkOrAnythingButThisBootsLineCountsForNothingAndGoesNotWhatItNames() throws Exception {
        Path elsewhere = Files.writeString(dir.resolve("elsewhere"), BOOT + "\n");
        Files.createSymbolicLink(dir.resolve(PolicyRestartMarker.UNLOCK), elsewhere);
        Files.writeString(dir.resolve(PolicyRestartMarker.LOCK), BOOT + "\n" + BOOT + "\n");
        gate.set(true);
        chromiumUp.set(true);
        stream = streamWithOwed();
        Thread.sleep(QUIET_MILLIS);
        assertThat(steps).isEmpty();
        assertThat(owedFile(PolicyRestartMarker.UNLOCK)).isFalse();
        assertThat(owedFile(PolicyRestartMarker.LOCK)).isFalse();
        assertThat(Files.readString(elsewhere)).isEqualTo(BOOT + "\n");
    }

    @Test
    void withNoBootIdNothingIsKeptOrTakenUp() throws Exception {
        owedBy(PolicyRestartMarker.LOCK, BOOT);
        stream = streamWithOwed(null);
        gate.set(true);
        Thread.sleep(QUIET_MILLIS);
        assertThat(steps).isEmpty();
        assertThat(owedFile(PolicyRestartMarker.LOCK)).isFalse();
        goLive("cs-1");
        stream.restartWhenUnused();
        Thread.sleep(QUIET_MILLIS);
        assertThat(owedFile(PolicyRestartMarker.UNLOCK)).isFalse();
    }
}
