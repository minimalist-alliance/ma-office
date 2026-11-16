package com.minimalistalliance.desk.agent.harness;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.harness.FaultMatrixTest.CallKind;
import com.minimalistalliance.desk.agent.harness.FaultMatrixTest.Fault;
import com.minimalistalliance.desk.agent.harness.FaultMatrixTest.Point;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The fault matrix's judge, against a deskd broken on purpose: a matrix that passes everything proves nothing unless it
 * fails what it should. A deskd that runs a retried key again is a double execution; one that says a call failed after
 * it took effect is a silent loss; one that says done and did nothing is a phantom.
 */
class FaultMatrixSelfTest {

    @TempDir
    static Path root;

    private static FaultMatrixTest.Result run(String id, CallKind kind, Point point, Fault fault,
            java.util.function.Consumer<CountingDeskd> broken) throws Exception {
        FaultMatrixTest.root = root;
        return FaultMatrixTest.run("self-" + id, kind.tool, kind, point, fault, broken);
    }

    @Test
    void aDeskdThatRunsARetriedKeyAgainIsADoubleExecution() throws Exception {
        // desk-agent's link drops after an unasked call ran; it asks again by key, and this deskd runs it again (an
        // approved one can't: its single-use ticket went with the first run).
        FaultMatrixTest.Result r = run("double", CallKind.AUTO, Point.RAN, Fault.DESKD_RESTART,
                d -> d.forgetKeys = true);
        assertThat(r.problems()).contains("DOUBLE");
    }

    @Test
    void aDeskdThatSaysACallFailedAfterItRanIsASilentLoss() throws Exception {
        FaultMatrixTest.Result r = run("loss", CallKind.WRITE, Point.ENDED, Fault.DESKD_RESTART,
                d -> d.lieAfterRun = true);
        assertThat(r.problems()).anyMatch(p -> p.startsWith("SILENT_LOSS"));
    }

    @Test
    void aDeskdThatSaysDoneAndDidNothingIsAPhantom() throws Exception {
        FaultMatrixTest.Result r = run("phantom", CallKind.DELETE, Point.ENDED, Fault.DESKD_RESTART,
                d -> d.skipRun = true);
        assertThat(r.problems()).contains("PHANTOM");
    }

    @Test
    void theSameCasesPassOnAnHonestDeskd() throws Exception {
        assertThat(run("honest-ran", CallKind.WRITE, Point.RAN, Fault.DESKD_RESTART, d -> { }).problems()).isEmpty();
        assertThat(run("honest-ended", CallKind.DELETE, Point.ENDED, Fault.DESKD_RESTART, d -> { }).problems())
                .isEmpty();
    }
}
