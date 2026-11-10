package com.minimalistalliance.desk.agent.team;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.minimalistalliance.desk.agent.store.TeamStore;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * The lead may only propose icons and tones the Agent app can draw, so desk-agent's lists must be the app's
 * ({@code web/agent/src/look/icons.ts} and {@code tones.ts}). Skipped when the web sources aren't beside this module.
 */
class LookIdsTest {

    private static final Path LOOK = Path.of(System.getProperty("basedir", "."), "../../web/agent/src/look")
            .normalize();

    private static List<String> ids(String file, Pattern pattern) throws IOException {
        Path path = LOOK.resolve(file);
        assumeTrue(Files.exists(path), path + " isn't here: the web sources aren't beside desk-agent");
        List<String> ids = new ArrayList<>();
        Matcher matcher = pattern.matcher(Files.readString(path, StandardCharsets.UTF_8));
        while (matcher.find()) {
            ids.add(matcher.group(1));
        }
        return ids;
    }

    @Test
    void theIconsAreTheAppsIcons() throws IOException {
        List<String> app = ids("icons.ts", Pattern.compile("^\\s*\\{ id: '([a-z][a-z0-9-]*)'", Pattern.MULTILINE));
        assertThat(app).isNotEmpty().doesNotHaveDuplicates();
        assertThat(TeamTools.ICONS).doesNotHaveDuplicates().containsExactlyInAnyOrderElementsOf(app);
    }

    @Test
    void theTonesAreTheAppsTones() throws IOException {
        List<String> app = ids("tones.ts", Pattern.compile("^\\s*\\['([a-z][a-z0-9-]*)', '", Pattern.MULTILINE));
        assertThat(app).isNotEmpty().doesNotHaveDuplicates();
        assertThat(TeamTools.TONES).doesNotHaveDuplicates().containsExactlyInAnyOrderElementsOf(app);
    }

    @Test
    void theListsAreTheContractsInItsOrder() {
        assertThat(TeamTools.TONES).containsExactly("graphite", "rose", "clay", "amber", "olive", "green", "teal",
                "cyan", "blue", "indigo", "violet", "plum");
        assertThat(TeamTools.ICONS).containsExactly("spark", "compass", "book", "pen", "calendar", "clock", "chart",
                "code", "mail", "person", "search", "leaf", "flask", "document", "music", "camera", "plane", "shield",
                "wallet", "bulb", "home", "bell", "list", "terminal");
    }

    @Test
    void eachRetiredIdIsGoneAndMapsToOneThatIsThere() {
        assertThat(TeamStore.RETIRED_ICONS).containsOnlyKeys("globe", "chat", "heart", "star", "puzzle", "briefcase");
        assertThat(TeamStore.RETIRED_TONES).containsOnlyKeys("moss", "sky");
        assertThat(TeamTools.ICONS).doesNotContainAnyElementsOf(TeamStore.RETIRED_ICONS.keySet())
                .containsAll(TeamStore.RETIRED_ICONS.values());
        assertThat(TeamTools.TONES).doesNotContainAnyElementsOf(TeamStore.RETIRED_TONES.keySet())
                .containsAll(TeamStore.RETIRED_TONES.values());
        assertThat(TeamTools.icon("globe")).isEqualTo("plane");
        assertThat(TeamTools.tone("sky")).isEqualTo("blue");
        assertThat(TeamTools.icon("leaf")).isEqualTo("leaf");
    }

    @Test
    void everyIdIsOneTheAgentCreateAcceptsAndTheLeadsDefaultsAreAmongThem() {
        assertThat(TeamTools.ICONS).allMatch(id -> Team.LOOK_ID.matcher(id).matches()).contains("spark");
        assertThat(TeamTools.TONES).allMatch(id -> Team.LOOK_ID.matcher(id).matches()).contains("graphite");
    }
}
