package com.minimalistalliance.desk.agent.memory;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Desk Maia's memory check, ported from Support Maia's ({@code services/maia/src/memory.ts}, ma-platform docs/maia.md
 * §16): each category it refuses, lookalikes and hidden characters folded first, and ordinary lines about how the member
 * likes help that still pass.
 */
class MaiaMemoryTest {

    @Test
    void privateLinesAreRefusedByCategory() {
        Map<String, List<String>> refused = Map.ofEntries(
                Map.entry("contact", List.of("Email is sam@example.com", "Call 303-555-0142", "Server at 10.0.0.12")),
                Map.entry("secret", List.of("The wifi password is hunter2", "My PIN is 4321", "Garage code 1234",
                        "Key sk-abcdefghijklmnop")),
                Map.entry("money", List.of("Has a big mortgage", "Pays the bills with a Visa", "Got laid off in May")),
                Map.entry("identity", List.of("Birthday is in March", "Lives in Denver", "Works at Acme",
                        "Is 34 years old")),
                Map.entry("address", List.of("Home is 12 Elm Street")),
                Map.entry("link", List.of("Reads https://news.example.com daily")),
                Map.entry("health", List.of("Has ADHD", "Is seeing a therapist", "Takes insulin", "Has AIDS")),
                Map.entry("addiction", List.of("Is sober since June", "Goes to AA meetings")),
                Map.entry("immigration", List.of("Is on a work visa", "Applying for citizenship")),
                Map.entry("criminal", List.of("Has a court date next week")),
                Map.entry("people", List.of("Their wife is a nurse", "Has two kids", "Uses Work for clients")),
                Map.entry("sexuality", List.of("Is gay", "Pronouns she/her")),
                Map.entry("beliefs", List.of("Goes to church on Sundays", "Votes Republican")),
                Map.entry("desk", List.of("Keeps my files tidy", "Their projects are due Friday")));
        refused.forEach((reason, lines) -> {
            for (String line : lines) {
                assertThat(MaiaMemory.privateReason(line)).as(line).isNotNull();
            }
        });
        assertThat(MaiaMemory.privateReason("Has ADHD")).isEqualTo("health");
        assertThat(MaiaMemory.privateReason("Email is sam@example.com")).isEqualTo("contact");
        assertThat(MaiaMemory.privateReason("Has two kids")).isEqualTo("people");
    }

    @Test
    void lookalikesHiddenCharactersMarkupAndLengthDontWalkPast() {
        // Fullwidth digits and a zero-width space still read as a phone number and a word.
        assertThat(MaiaMemory.privateReason("Call ３０３５５５０１４２")).isEqualTo("contact");
        assertThat(MaiaMemory.privateReason("Has a ther​apist")).isEqualTo("health");
        assertThat(MaiaMemory.privateReason("Likes <b>bold</b>")).isEqualTo("markup");
        assertThat(MaiaMemory.privateReason("Prefers " + "short ".repeat(40))).isEqualTo("too_long");
        assertThat(MaiaMemory.privateReason(null)).isNotNull();
    }

    @Test
    void howTheMemberLikesHelpStillPasses() {
        for (String line : List.of("Prefers short answers", "Likes step-by-step instructions",
                "Wants a plan before anything starts", "Uses the Work desk most", "Likes choices to tap",
                "Prefers metric units", "Wants briefs sent to the Lead first", "Likes to pin windows")) {
            assertThat(MaiaMemory.privateReason(line)).as(line).isNull();
        }
        // Her own instructions' examples pass her own check.
        assertThat(MaiaMemory.PROMPT).contains("Private things are never remembered").contains("memory_save")
                .doesNotContain("own key");
    }
}
