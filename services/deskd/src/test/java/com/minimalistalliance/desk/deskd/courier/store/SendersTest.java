package com.minimalistalliance.desk.deskd.courier.store;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/** The lookalike checks' pieces (draft ADR "Courier's store" §17), without a store. */
class SendersTest {

    @Test
    void skeletonsSeeThroughTheLettersThatPassForOthers() {
        assertThat(Senders.skeleton("paypa1.com")).isEqualTo(Senders.skeleton("paypal.com"));
        assertThat(Senders.skeleton("rnicrosoft.com")).isEqualTo(Senders.skeleton("microsoft.com"));
        assertThat(Senders.skeleton("\u0430pple.com")).isEqualTo(Senders.skeleton("apple.com")); // Cyrillic a
        assertThat(Senders.skeleton("g\u043e\u043egle.com")).isEqualTo(Senders.skeleton("google.com")); // Cyrillic o o
        assertThat(Senders.skeleton("amaz0n.com")).isEqualTo(Senders.skeleton("amazon.com"));
        assertThat(Senders.skeleton("pay-pal.com")).isEqualTo(Senders.skeleton("paypal.com"));
        assertThat(Senders.skeleton("\uff50\uff41\uff59\uff50\uff41\uff4c.com")).isEqualTo(Senders.skeleton("paypal.com")); // full width
        assertThat(Senders.skeleton("p\u00e1ypal.com")).isEqualTo(Senders.skeleton("paypal.com"));
        assertThat(Senders.skeleton("example.org")).isNotEqualTo(Senders.skeleton("example.com"));
    }

    @Test
    void registrableDomainsKeepCountrySecondLevels() {
        assertThat(Senders.registrable("mail.paypal.com")).isEqualTo("paypal.com");
        assertThat(Senders.registrable("a.b.example.co.uk")).isEqualTo("example.co.uk");
        assertThat(Senders.registrable("example.com")).isEqualTo("example.com");
        assertThat(Senders.registrable("localhost")).isEqualTo("localhost");
    }

    @Test
    void oneEditMeansOneLetterAddedDroppedChangedOrSwapped() {
        assertThat(Senders.oneEditApart("google", "gooogle")).isTrue();
        assertThat(Senders.oneEditApart("google", "gogle")).isTrue();
        assertThat(Senders.oneEditApart("google", "goigle")).isTrue();
        assertThat(Senders.oneEditApart("google", "googel")).isTrue();
        assertThat(Senders.oneEditApart("google", "google")).isFalse();
        assertThat(Senders.oneEditApart("google", "goggles")).isFalse();
        assertThat(Senders.oneEditApart("google", "yahoo")).isFalse();
    }

    @Test
    void internationalizedDomainsThatDeceiveAreShownAsAscii() {
        assertThat(Senders.deceptiveIdn("\u0430pple.com")).isTrue(); // mixed: Cyrillic a with Latin
        assertThat(Senders.deceptiveIdn("\u0440\u0430\u0443\u0440\u0430\u04cf.com")).isTrue(); // all Cyrillic, all pass for Latin
        assertThat(Senders.deceptiveIdn("\u043f\u043e\u0447\u0442\u0430.\u0440\u0444")).isFalse(); // one script, doesn't pass for Latin
        assertThat(Senders.deceptiveIdn("caf\u00e9.fr")).isFalse();
        assertThat(Senders.deceptiveIdn("\u4f8b\u3048.jp")).isFalse();
        assertThat(Senders.deceptiveIdn("example.com")).isFalse();
        assertThat(Senders.ascii("\u0430pple.com")).startsWith("xn--");
    }

    @Test
    void nameKeysFoldOrderAndPunctuationAndSkipRoles() {
        assertThat(Senders.nameKey("Dana Smith")).isEqualTo(Senders.nameKey("smith, DANA"));
        assertThat(Senders.nameKey("Ren\u00e9e O'Neil")).isEqualTo(Senders.nameKey("renee o neil"));
        assertThat(Senders.nameKey("Support")).isNull();
        assertThat(Senders.nameKey("No-Reply")).isNull();
        assertThat(Senders.nameKey("Al")).isNull();
        assertThat(Senders.nameKey(null)).isNull();
    }

    @Test
    void anEndpointsSkeletonIsItsRegistrableDomains() {
        assertThat(Senders.endpointSkel("email", "dana@mail.acme.example")).isEqualTo(Senders.skeleton("acme.example"));
        assertThat(Senders.endpointSkel("phone", "+15550001111")).isNull();
    }
}
