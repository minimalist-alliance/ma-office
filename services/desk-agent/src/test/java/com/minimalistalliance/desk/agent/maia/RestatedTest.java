package com.minimalistalliance.desk.agent.maia;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/** Desk Maia's restatement guard: a later step of her run says only what's new. */
class RestatedTest {

    /** The turn's words in the owner's first reply (Nov 15), verbatim. */
    static final String TURN = "Welcome, I'm Maia. You tell me what you want done, and I hand the work to the agents on"
            + " your desks, then come back to you with the result. I also keep a short to-do list here. None of your"
            + " desks are switched on for me yet. You can do that in Maia Mode's settings. Until then, we can talk,"
            + " and I can keep your to-do list. What would you like to start with?";
    /** The step's words after her tool, verbatim: the same reply again. */
    static final String STEP = "Welcome! I'm Maia. You tell me what you want done, and I ask the agents on your desks"
            + " to do the work, then bring the results back to you. I also keep a short to-do list for you here. No"
            + " desks are switched on for me yet. You can switch them on in Maia Mode's settings. Until then, we can"
            + " talk, and I can keep your to-do list. What would you like to start with?";

    @Test
    void theOwnersDoubledWelcomeLosesItsSecondCopy() {
        assertThat(Restated.fresh(TURN, STEP)).isEmpty();
    }

    @Test
    void theSameWordsTwiceAreDropped() {
        assertThat(Restated.fresh("Welcome. I'm glad you're here.", "Welcome. I'm glad you're here.")).isEmpty();
    }

    @Test
    void aResultAfterSayingWhatSheWouldDoIsKept() {
        String first = "Let me look at your desks.";
        String next = "You have two desks, Work and Personal. Which one should I use?";
        assertThat(Restated.fresh(first, next)).isEqualTo(next);
        assertThat(Restated.fresh("I'll ask your Work desk to compare laptops.",
                "Your Work desk found three under $1,000; the lightest is the Aero 14.")).startsWith("Your Work desk");
    }

    @Test
    void onlyTheSentencesSheAlreadySaidAreDropped() {
        String first = "I asked your Work desk to compare three laptops under $1,000.";
        String next = "I asked your Work desk to compare three laptops under $1,000. The Aero 14 is the lightest, and"
                + " the Swift is cheapest.";
        assertThat(Restated.fresh(first, next)).isEqualTo("The Aero 14 is the lightest, and the Swift is cheapest.");
    }

    @Test
    void aShortLineAfterAToolIsKept() {
        assertThat(Restated.fresh("Let me check.", "Done.")).isEqualTo("Done.");
        assertThat(Restated.fresh("", "Hello.")).isEqualTo("Hello.");
        assertThat(Restated.fresh("Hello.", "")).isEmpty();
    }

    @Test
    void aLongerPartKeepsOnlyWhatContinuesFromTheShortReply() {
        String text = "Your Work desk found three laptops under $1,000.\n<more>\nYour Work desk found three laptops under"
                + " $1,000. The Aero 14 is the lightest at 1.1 kg; the Swift has the longest battery.";
        assertThat(Restated.withMore(text)).isEqualTo("Your Work desk found three laptops under $1,000.\n\n<more>\n"
                + "The Aero 14 is the lightest at 1.1 kg; the Swift has the longest battery.");
    }

    @Test
    void aLongerPartThatOnlyRepeatsGoesWithItsMarker() {
        assertThat(Restated.withMore("Welcome. I'm glad you're here.\n<more>\nWelcome! I'm glad you're here.</more>"))
                .isEqualTo("Welcome. I'm glad you're here.");
        assertThat(Restated.withMore("No longer part here.")).isEqualTo("No longer part here.");
        assertThat(Restated.withMore("<more>\nOnly a longer part.")).isEqualTo("Only a longer part.");
    }

    @Test
    void aSentenceThatChangesANumberOrSaysNoIsKept() {
        // Security's MV-L1: a reversal or a changed figure is something new.
        assertThat(Restated.fresh("Your Work desk has 12 laptops left.", "Your Work desk has 2 laptops left."))
                .isEqualTo("Your Work desk has 2 laptops left.");
        assertThat(Restated.fresh("The Work desk can send the newsletter tonight.",
                "No, the Work desk can't send the newsletter tonight.")).isNotEmpty();
    }

    @Test
    void stemsMatchSimpleEndings() {
        assertThat(Restated.stem("switched")).isEqualTo(Restated.stem("switch"));
        assertThat(Restated.stem("desks")).isEqualTo(Restated.stem("desk"));
        assertThat(Restated.stem("mode's")).isEqualTo("mode");
    }
}
