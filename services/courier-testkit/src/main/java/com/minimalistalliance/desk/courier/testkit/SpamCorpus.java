package com.minimalistalliance.desk.courier.testkit;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.SplittableRandom;

/**
 * A labelled spam and wanted-mail corpus for Courier's learning filter (Wave 3.2), generated: no real mail, no third-party
 * corpus. Each sample is an RFC 5322 message from a stranger, with whether it's spam and its family. Spam families:
 * pharmacy, investment and crypto, prize and lottery, account phishing, fake invoices carrying an attachment, loans, dating,
 * cold sales pitches. Wanted families: a person writing, work, school and clubs, receipts, newsletters, travel, a
 * neighbour. The families share filler words, names, links and a few each other's words ("free", "offer", "account",
 * "invoice", "meeting"), so the filter has to weigh rather than match.
 *
 * <p>Sample {@code n} comes from its own {@link SplittableRandom} seeded from the seed and {@code n} alone, and nothing
 * here reads the clock, the host or the default locale, so a seed gives the same bytes on every run and a shorter run is a
 * prefix of a longer one. Spam and wanted alternate by a fixed pattern (3 spam in every 7), so any 7 have both.
 */
public final class SpamCorpus {

    public static final long DEFAULT_SEED = 20261114L;

    private SpamCorpus() {}

    /** One generated message. */
    public record Sample(String name, String family, boolean spam, String from, byte[] raw) {}

    private record Family(String name, boolean spam, String[] senders, String[] domains, String[] subjects, String[] words,
            String[] attachments) {}

    private static final String[] FILLER = {"the", "and", "you", "your", "for", "with", "this", "that", "have", "will", "from",
        "about", "today", "please", "here", "more", "just", "time", "know", "would", "like", "thanks", "hope", "week", "next",
        "also", "really", "good", "best", "regards", "soon", "some", "great", "make", "sure", "any", "get", "new", "free", "offer",
        "account", "click", "link", "below", "information", "details", "update"};

    private static final String[] FIRST = {"Dana", "Sam", "Alex", "Priya", "Jordan", "Maria", "Chen", "Lee", "Fatima", "Omar",
        "Sofia", "Lucas", "Amara", "Kenji", "Elena", "Noah", "Ines", "Ravi", "Hana", "Tom"};
    private static final String[] LAST = {"Smith", "Garcia", "Nguyen", "Patel", "Kim", "Okafor", "Rossi", "Silva", "Cohen",
        "Novak", "Berg", "Tanaka", "Haddad", "Murphy", "Lopez"};

    private static final List<Family> FAMILIES = List.of(
            new Family("pharmacy", true, new String[] {"Online Pharmacy", "RX Deals", "Health Store", "MedsDirect"},
                    new String[] {"rx-deals.example", "pharma-direct.example", "cheap-meds.example", "healthsave.example"},
                    new String[] {"Cheap meds without prescription", "Save 80% on your pills", "Discreet shipping on all orders",
                        "Your order discount inside", "Best prices on medication"},
                    new String[] {"pills", "prescription", "pharmacy", "viagra", "cialis", "discount", "shipping", "discreet",
                        "order", "generic", "dosage", "tablets", "lowest", "price", "guaranteed", "overnight", "satisfaction"},
                    new String[0]),
            new Family("crypto", true, new String[] {"Crypto Profits", "Investment Desk", "Bitcoin Club", "Wealth Team"},
                    new String[] {"coin-profits.example", "invest-now.example", "btc-club.example", "wealth-fast.example"},
                    new String[] {"Turn 250 into 25,000 in a week", "The coin everyone is buying", "Guaranteed returns this month",
                        "Your investment opportunity expires", "Insider crypto tip"},
                    new String[] {"bitcoin", "crypto", "profit", "returns", "guaranteed", "invest", "wallet", "opportunity",
                        "millionaire", "trading", "platform", "deposit", "withdraw", "signals", "exclusive", "risk", "earn"},
                    new String[0]),
            new Family("prize", true, new String[] {"Prize Center", "Lottery Board", "Winner Notice", "Rewards Dept"},
                    new String[] {"prize-center.example", "lotto-intl.example", "winner-notice.example", "rewards-claim.example"},
                    new String[] {"Congratulations you have won", "Claim your prize now", "Final notice: unclaimed reward",
                        "You were selected", "Your gift card is waiting"},
                    new String[] {"congratulations", "winner", "prize", "claim", "lottery", "selected", "reward", "gift",
                        "card", "unclaimed", "processing", "fee", "beneficiary", "million", "dollars", "transfer", "notice"},
                    new String[0]),
            new Family("phishing", true, new String[] {"Account Security", "Support Team", "Billing Service", "Mail Admin"},
                    new String[] {"secure-verify.example", "account-alert.example", "login-check.example", "mailbox-admin.example"},
                    new String[] {"Your account has been suspended", "Unusual sign-in activity", "Verify your account now",
                        "Action required: password expires", "Your mailbox is full"},
                    new String[] {"suspended", "verify", "password", "expires", "login", "unusual", "activity", "confirm",
                        "identity", "security", "locked", "restore", "access", "immediately", "within", "hours", "credentials"},
                    new String[0]),
            new Family("invoice", true, new String[] {"Accounts Payable", "Invoice Dept", "Payments", "Billing"},
                    new String[] {"inv-docs.example", "payment-notice.example", "billing-dept.example", "docs-share.example"},
                    new String[] {"Invoice overdue", "Payment confirmation attached", "Remittance advice", "Outstanding invoice",
                        "Please review the attached document"},
                    new String[] {"invoice", "overdue", "attached", "payment", "remittance", "outstanding", "document",
                        "enable", "content", "macros", "review", "urgent", "transfer", "wire", "due", "balance", "kindly"},
                    new String[] {"invoice.zip|application/zip|PK", "document.docm|application/vnd.ms-word.document.macroEnabled.12|PK",
                        "payment.exe|application/octet-stream|MZ", "scan.iso|application/x-iso9660-image|CD"}),
            new Family("loan", true, new String[] {"Loan Approval", "Fast Cash", "Credit Help", "Debt Relief"},
                    new String[] {"fast-loans.example", "cash-today.example", "credit-fix.example", "debt-away.example"},
                    new String[] {"You are pre-approved", "Cash in your account today", "Bad credit? No problem",
                        "Lower your payments now", "Instant loan decision"},
                    new String[] {"loan", "approved", "cash", "credit", "score", "instant", "decision", "lender", "rates",
                        "debt", "relief", "consolidate", "apply", "funds", "eligible", "today", "minutes"},
                    new String[0]),
            new Family("dating", true, new String[] {"Anna", "Katya", "Lovely Matches", "Meet Singles"},
                    new String[] {"meet-singles.example", "lonely-hearts.example", "date-tonight.example", "match-now.example"},
                    new String[] {"I saw your profile", "Someone wants to meet you", "Are you free tonight", "New message from a match",
                        "Lonely? Talk to me"},
                    new String[] {"profile", "lonely", "singles", "meet", "tonight", "photos", "chat", "beautiful", "waiting",
                        "match", "private", "hot", "dating", "romance", "kiss", "darling", "honey"},
                    new String[0]),
            new Family("pitch", true, new String[] {"Growth Agency", "SEO Experts", "Lead Gen Team", "Web Services"},
                    new String[] {"seo-boost.example", "leads-galore.example", "rank-first.example", "web-growth.example"},
                    new String[] {"Rank first on Google", "More leads for your business", "Quick question about your website",
                        "Grow your traffic 10x", "Partnership proposal"},
                    new String[] {"seo", "ranking", "traffic", "leads", "website", "agency", "marketing", "backlinks",
                        "guaranteed", "first", "page", "business", "audit", "proposal", "clients", "results", "affordable"},
                    new String[0]),
            new Family("personal", false, new String[0],
                    new String[] {"gmail.example", "icloud.example", "fastmail.example", "proton.example"},
                    new String[] {"Lunch on Tuesday?", "Photos from the weekend", "Happy birthday!", "Are we still on for Saturday",
                        "Quick favour"},
                    new String[] {"lunch", "weekend", "photos", "birthday", "dinner", "kids", "mom", "visit", "saturday",
                        "park", "movie", "coffee", "call", "miss", "family", "garden", "recipe"},
                    new String[] {"photo.jpg|image/jpeg|JPG"}),
            new Family("work", false, new String[0],
                    new String[] {"acme-corp.example", "northwind.example", "contoso.example", "fabrikam.example"},
                    new String[] {"Notes from the project meeting", "Draft report for review", "Agenda for Thursday",
                        "Budget figures", "Follow-up on the proposal"},
                    new String[] {"project", "meeting", "agenda", "report", "draft", "review", "budget", "deadline",
                        "thursday", "team", "notes", "figures", "quarter", "proposal", "feedback", "slides", "schedule"},
                    new String[] {"report.pdf|application/pdf|%PDF", "figures.xlsx|application/vnd.openxmlformats-officedocument.spreadsheetml.sheet|PK"}),
            new Family("school", false, new String[] {"Riverside School", "Chess Club", "Book Club", "Youth Soccer"},
                    new String[] {"riverside-school.example", "chessclub.example", "bookclub.example", "soccer-league.example"},
                    new String[] {"Practice moved to Friday", "This month's book", "Parent evening", "Tournament schedule",
                        "Volunteers needed"},
                    new String[] {"practice", "friday", "parents", "students", "club", "tournament", "season", "volunteers",
                        "teacher", "class", "field", "trip", "book", "chapter", "members", "snacks", "uniform"},
                    new String[0]),
            new Family("receipt", false, new String[] {"Hardware Store", "Corner Books", "City Transit", "Grocer"},
                    new String[] {"hardware-shop.example", "cornerbooks.example", "citytransit.example", "grocer.example"},
                    new String[] {"Your receipt", "Order shipped", "Thanks for your purchase", "Your monthly pass",
                        "Order confirmation"},
                    new String[] {"receipt", "order", "shipped", "purchase", "total", "item", "quantity", "tracking",
                        "delivery", "store", "returns", "pass", "subtotal", "tax", "paid", "card", "ending"},
                    new String[] {"receipt.pdf|application/pdf|%PDF"}),
            new Family("newsletter", false, new String[] {"Local Paper", "Garden Notes", "Tech Weekly", "Museum News"},
                    new String[] {"localpaper.example", "gardennotes.example", "techweekly.example", "museum.example"},
                    new String[] {"This week in the garden", "Your weekly roundup", "New exhibition opens", "Top stories",
                        "Monthly newsletter"},
                    new String[] {"newsletter", "weekly", "stories", "exhibition", "garden", "season", "events", "article",
                        "read", "community", "issue", "subscribe", "unsubscribe", "highlights", "upcoming", "museum", "local"},
                    new String[0]),
            new Family("travel", false, new String[] {"Rail Bookings", "Seaside Hotel", "Airline Check-in", "Ferry Line"},
                    new String[] {"railbookings.example", "seasidehotel.example", "air-checkin.example", "ferryline.example"},
                    new String[] {"Your booking is confirmed", "Check-in opens tomorrow", "Your itinerary", "Reservation details",
                        "Boarding pass"},
                    new String[] {"booking", "confirmed", "itinerary", "reservation", "check", "departure", "arrival",
                        "seat", "platform", "hotel", "nights", "guests", "boarding", "gate", "passengers", "ticket", "flight"},
                    new String[] {"itinerary.pdf|application/pdf|%PDF"}),
            new Family("neighbour", false, new String[0],
                    new String[] {"mail.example", "home.example", "neighbours.example"},
                    new String[] {"Your parcel is with me", "Street party", "Hedge trimming", "Found your cat", "Bin day changed"},
                    new String[] {"parcel", "neighbour", "street", "party", "hedge", "cat", "bins", "door", "garden",
                        "fence", "road", "evening", "leave", "number", "house", "noise", "borrow"},
                    new String[0]));

    /** {@code count} samples from {@code seed}. */
    public static List<Sample> generate(long seed, int count) {
        List<Family> spam = FAMILIES.stream().filter(Family::spam).toList();
        List<Family> wanted = FAMILIES.stream().filter(f -> !f.spam()).toList();
        List<Sample> out = new ArrayList<>(count);
        for (int n = 0; n < count; n++) {
            SplittableRandom r = new SplittableRandom(seed * 1_000_003L + n);
            boolean isSpam = (n % 7) < 3;
            Family f = isSpam ? spam.get(r.nextInt(spam.size())) : wanted.get(r.nextInt(wanted.size()));
            out.add(sample(n, f, r));
        }
        return out;
    }

    private static Sample sample(int n, Family f, SplittableRandom r) {
        String first = pick(FIRST, r);
        String last = pick(LAST, r);
        String domain = f.spam() ? pick(f.domains(), r).replace(".example", "-" + r.nextInt(400) + ".example") : pick(f.domains(), r);
        String display;
        String local;
        if (f.senders().length == 0) {
            display = first + " " + last;
            local = (first + "." + last).toLowerCase(Locale.ROOT) + (r.nextInt(3) == 0 ? Integer.toString(r.nextInt(100)) : "");
        } else {
            display = pick(f.senders(), r);
            local = f.spam() ? pick(new String[] {"info", "noreply", "service", "offers", "team", "support"}, r) + r.nextInt(90)
                    : pick(new String[] {"hello", "news", "orders", "bookings", "office", "club"}, r);
        }
        String from = local + "@" + domain;
        String subject = pick(f.subjects(), r);
        if (f.spam() && r.nextInt(4) == 0) {
            subject = subject.toUpperCase(Locale.ROOT);
        }
        StringBuilder text = new StringBuilder();
        text.append(f.spam() ? pick(new String[] {"Dear customer,", "Hello friend,", "Dear " + first + ",", "Hi,"}, r)
                : pick(new String[] {"Hi " + pick(FIRST, r) + ",", "Hello,", "Hey,", "Dear member,"}, r)).append("\n\n");
        int sentences = 2 + r.nextInt(5);
        for (int s = 0; s < sentences; s++) {
            int words = 6 + r.nextInt(10);
            for (int w = 0; w < words; w++) {
                String word = r.nextInt(5) < 2 ? pick(f.words(), r) : r.nextInt(12) == 0 ? pick(otherFamily(f, r).words(), r) : pick(FILLER, r);
                text.append(w == 0 ? Character.toUpperCase(word.charAt(0)) + word.substring(1) : word).append(w == words - 1 ? ". " : " ");
            }
            if (s % 3 == 2) {
                text.append('\n');
            }
        }
        if (f.spam() || r.nextInt(3) == 0) {
            String host = f.spam() ? domain : pick(f.domains(), r);
            text.append("\n\nhttps://").append(host).append('/').append(pick(f.words(), r)).append("?id=").append(r.nextInt(100_000)).append('\n');
        }
        text.append("\n").append(f.spam() ? pick(new String[] {"Best regards", "Sincerely", "Act now", "Thank you"}, r)
                : pick(new String[] {"Thanks", "Cheers", "See you soon", "Best"}, r)).append(",\n").append(f.senders().length == 0 ? first : display).append('\n');
        boolean bulk = f.name().equals("newsletter") || f.name().equals("receipt") || (f.spam() && r.nextInt(2) == 0);
        String attachment = f.attachments().length > 0 && r.nextInt(f.spam() ? 1 : 3) == 0 ? pick(f.attachments(), r) : null;
        String date = DateTimeFormatter.RFC_1123_DATE_TIME.format(Instant.parse("2026-10-01T09:00:00Z").plusSeconds(3_600L * n).atOffset(ZoneOffset.UTC));
        StringBuilder m = new StringBuilder();
        m.append("From: ").append(display).append(" <").append(from).append(">\r\n");
        m.append("To: me@desk.example\r\n");
        m.append("Subject: ").append(subject).append("\r\n");
        m.append("Date: ").append(date).append("\r\n");
        m.append("Message-ID: <spam-corpus-").append(n).append('@').append(domain).append(">\r\n");
        if (bulk) {
            m.append("List-Unsubscribe: <https://").append(domain).append("/unsubscribe>\r\n");
        }
        m.append("MIME-Version: 1.0\r\n");
        if (attachment == null) {
            m.append("Content-Type: text/plain; charset=utf-8\r\n\r\n").append(text.toString().replace("\n", "\r\n"));
        } else {
            String[] a = attachment.split("\\|");
            m.append("Content-Type: multipart/mixed; boundary=\"b-").append(n).append("\"\r\n\r\n");
            m.append("--b-").append(n).append("\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n").append(text.toString().replace("\n", "\r\n"));
            m.append("\r\n--b-").append(n).append("\r\nContent-Type: ").append(a[1]).append("; name=\"").append(a[0])
                    .append("\"\r\nContent-Disposition: attachment; filename=\"").append(a[0]).append("\"\r\nContent-Transfer-Encoding: base64\r\n\r\n");
            byte[] body = new byte[200 + r.nextInt(800)];
            byte[] magic = a[2].getBytes(StandardCharsets.US_ASCII);
            for (int i = 0; i < body.length; i++) {
                body[i] = i < magic.length ? magic[i] : (byte) r.nextInt(256);
            }
            m.append(java.util.Base64.getMimeEncoder(76, new byte[] {'\r', '\n'}).encodeToString(body));
            m.append("\r\n--b-").append(n).append("--\r\n");
        }
        return new Sample("spam-corpus-" + n, f.name(), f.spam(), from, m.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static Family otherFamily(Family f, SplittableRandom r) {
        Family o = FAMILIES.get(r.nextInt(FAMILIES.size()));
        return o == f ? FAMILIES.get((FAMILIES.indexOf(f) + 1) % FAMILIES.size()) : o;
    }

    private static String pick(String[] options, SplittableRandom r) {
        return options[r.nextInt(options.length)];
    }
}
