package com.minimalistalliance.desk.agent.maia.eval;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.maia.DocReader;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;

/**
 * Documents' reader with a <b>real</b> model on the ten documents of {@link DocReaderCorpus}, scored against the
 * concept's E4 targets ("due exact" at least 90%, "page correct" at least 95%, "schema valid after code" 100%). Never runs
 * by default or in a {@code verify}: only with {@code -Ddocs.reader.real=true -Dtest=DocReaderRealModelCheck}.
 *
 * <p>The model is pluggable: {@code -Ddocs.reader.model=<class>} names a class on the test classpath that implements
 * {@link DocReader.Model} with a public no-argument constructor, and gets exactly what production's reader sends (the
 * rule as the system part, the fenced document, 600 output tokens at most). Without one the check is skipped and says
 * why. Nothing here reads a key or a secret.
 *
 * <p><b>The real call is the next step, not done here.</b> The reader's model is Desk Maia's service, task {@code read},
 * on the company's account: there is no path to it from a build machine, only from a desk, through deskd's
 * {@code maia_model} relay ({@code AgentService.docRead} → {@code MaiaHooks.complete(maia, "read", ...)}). What it needs:
 * a staging desk with Maia Mode on (listed, the member's disclosure, her home desk set) and the Platform serving the
 * {@code read} task on her service; then a {@code DocReader.Model} that makes that same call there (or this corpus sent as
 * {@code desk.docs.read} requests to that desk's desk-agent, with no caller, and the answers scored the same way).
 */
@EnabledIfSystemProperty(named = "docs.reader.real", matches = "true")
class DocReaderRealModelCheck {

    @Test
    void aRealModelsReadingsMeetTheTargetsAfterCode() throws Exception {
        String name = System.getProperty("docs.reader.model");
        Assumptions.assumeTrue(name != null && !name.isBlank(), "no model: set -Ddocs.reader.model to a DocReader.Model"
                + " class that reaches Desk Maia's service (task read) from a staging desk with Maia Mode on");
        DocReader.Model model = (DocReader.Model) Class.forName(name).getDeclaredConstructor().newInstance();
        DocReaderCorpus.Scores s = DocReaderCorpus.score(new DocReader(model));
        System.out.println(s.line("real-model check (" + name + ")"));
        assertThat(s.schema()).as(s.line("real")).isEqualTo(1.0);
        assertThat(s.due()).as(s.line("real")).isGreaterThanOrEqualTo(0.90);
        assertThat(s.page()).as(s.line("real")).isGreaterThanOrEqualTo(0.95);
    }
}
