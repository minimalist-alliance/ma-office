package com.minimalistalliance.desk.agent.attach;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;

/** {@code -Ddocs.corpus.out=DIR -Dtest=DocsCorpusExport}: writes Documents' synthetic corpus for deskd's corpus run. */
class DocsCorpusExport {

    @Test
    @EnabledIfSystemProperty(named = "docs.corpus.out", matches = ".+")
    void writesTheCorpus() throws Exception {
        assertThat(DocsFixtures.writeCorpus(Path.of(System.getProperty("docs.corpus.out")))).isGreaterThan(20);
    }
}
