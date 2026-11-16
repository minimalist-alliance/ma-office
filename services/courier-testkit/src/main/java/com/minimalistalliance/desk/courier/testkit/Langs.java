package com.minimalistalliance.desk.courier.testkit;

import java.nio.charset.Charset;
import java.nio.charset.CharsetEncoder;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * The generator's languages and charsets. Each language is a vocabulary of real words in its own script (everyday office
 * words, no names) and a few senders' display names; each charset lists the languages it can carry. Words a charset can't
 * encode are left out when text is written in it, and the generator checks every text survives its charset both ways.
 */
final class Langs {

    private Langs() {
    }

    /** A language: its words, display names for senders, how a sentence ends, and whether a sentence starts upper case. */
    record Lang(String code, List<String> words, List<String> names, String stop, boolean cased) {

        /** The words {@code charset} can encode. */
        List<String> wordsIn(Charset charset) {
            CharsetEncoder enc = charset.newEncoder();
            List<String> out = new ArrayList<>();
            for (String w : words) {
                if (enc.canEncode(w)) {
                    out.add(w);
                }
            }
            return out;
        }

        /** The words fit to be a sample's {@code word}: at least four letters, all letters, already lower case. */
        List<String> checkWordsIn(Charset charset) {
            List<String> out = new ArrayList<>();
            for (String w : wordsIn(charset)) {
                if (isCheckWord(w)) {
                    out.add(w);
                }
            }
            return out;
        }
    }

    static boolean isCheckWord(String w) {
        return w.codePointCount(0, w.length()) >= 4 && w.codePoints().allMatch(Character::isLetter)
                && w.toLowerCase(Locale.ROOT).equals(w);
    }

    static final Lang EN = new Lang("en", List.of(
            "meeting", "budget", "schedule", "report", "project", "invoice", "review", "quarter", "office", "garden", "weather",
            "tomorrow", "morning", "update", "results", "travel", "coffee", "numbers", "contract", "summary", "planning",
            "deadline", "kitchen", "library", "window", "hiring", "shipment", "delivery", "package", "holiday", "workshop",
            "agenda", "minutes", "client", "proposal", "account", "payment", "request", "approval", "thanks", "please", "team",
            "notes", "draft", "final", "the", "and", "for", "with", "about", "from", "our", "this", "next", "week", "will",
            "have", "been", "today", "lunch", "printer", "parking", "training", "survey", "feedback", "launch", "timeline"),
            List.of("Billing Team", "Office Manager", "News Desk", "Support", "Travel Desk", "Facilities", "Events"), ".", true);

    static final Lang FR = new Lang("fr", List.of(
            "réunion", "budget", "demain", "matin", "rapport", "projet", "facture", "équipe", "bureau", "jardin", "météo",
            "déjeuner", "été", "très", "déjà", "prévu", "réservé", "hôtel", "forêt", "château", "leçon", "reçu", "noël",
            "naïve", "cœur", "œuvre", "semaine", "prochaine", "contrat", "livraison", "commande", "planning", "merci",
            "bientôt", "fenêtre", "café", "le", "la", "les", "de", "du", "pour", "avec", "sur", "dans", "nous", "vous",
            "coût", "élevé", "à", "où", "dès", "après"),
            List.of("Service client", "Équipe facturation", "Secrétariat", "Accueil", "Ressources humaines"), ".", true);

    static final Lang DE = new Lang("de", List.of(
            "straße", "größe", "übermorgen", "ärger", "öffnen", "müssen", "prüfung", "grüße", "besprechung", "termin",
            "rechnung", "bericht", "mannschaft", "wetter", "frühstück", "schlüssel", "gebäude", "zeitplan", "haushalt",
            "vertrag", "lieferung", "bestellung", "kollegen", "und", "der", "die", "das", "mit", "für", "über", "nächste",
            "woche", "heute", "morgen", "büro", "kaffee", "drucker", "urlaub", "schulung", "danke", "bitte", "gemüse"),
            List.of("Buchhaltung", "Kundendienst", "Sekretariat", "Personalabteilung", "Empfang"), ".", true);

    static final Lang ES = new Lang("es", List.of(
            "reunión", "mañana", "presupuesto", "informe", "proyecto", "factura", "equipo", "oficina", "jardín", "pequeño",
            "año", "niño", "también", "corazón", "canción", "cumpleaños", "semana", "próxima", "gracias", "envío", "entrega",
            "contrato", "el", "la", "de", "con", "para", "por", "nuestro", "hoy", "café", "almuerzo", "pedido", "cliente",
            "calendario", "vacaciones", "pingüino", "señal"),
            List.of("Atención al cliente", "Facturación", "Recepción", "Recursos humanos"), ".", true);

    static final Lang PL = new Lang("pl", List.of(
            "spotkanie", "jutro", "budżet", "raport", "projekt", "faktura", "zespół", "biuro", "ogród", "pogoda", "dziękuję",
            "proszę", "źródło", "żółty", "świeży", "gęś", "łąka", "wiadomość", "harmonogram", "umowa", "dostawa", "tydzień",
            "przyszły", "i", "w", "z", "na", "do", "dzisiaj", "kawa", "drukarka", "urlop", "szkolenie", "zamówienie",
            "książka", "miasto"),
            List.of("Dział sprzedaży", "Księgowość", "Sekretariat", "Obsługa klienta"), ".", true);

    static final Lang CS = new Lang("cs", List.of(
            "schůzka", "zítra", "rozpočet", "zpráva", "projekt", "faktura", "kancelář", "zahrada", "počasí", "děkuji",
            "prosím", "příští", "týden", "smlouva", "dodávka", "řeka", "kůň", "úterý", "čtvrtek", "a", "v", "na", "do", "se",
            "dnes", "káva", "tiskárna", "dovolená", "školení", "objednávka", "město", "kniha"),
            List.of("Zákaznická podpora", "Účtárna", "Sekretariát", "Recepce"), ".", true);

    static final Lang TR = new Lang("tr", List.of(
            "toplantı", "yarın", "bütçe", "rapor", "proje", "fatura", "ekip", "ofis", "bahçe", "hava", "teşekkürler",
            "lütfen", "gelecek", "hafta", "sözleşme", "teslimat", "ağaç", "çiçek", "güneş", "şehir", "öğle", "ve", "ile",
            "için", "bu", "bugün", "kahve", "yazıcı", "tatil", "eğitim", "sipariş", "kitap", "müşteri"),
            List.of("Müşteri hizmetleri", "Muhasebe", "Sekreterlik", "Satış ekibi"), ".", true);

    static final Lang RU = new Lang("ru", List.of(
            "встреча", "завтра", "бюджет", "отчёт", "проект", "счёт", "команда", "офис", "сад", "погода", "спасибо",
            "пожалуйста", "неделя", "следующий", "договор", "доставка", "совещание", "расписание", "письмо", "вопрос", "и",
            "в", "на", "с", "по", "для", "сегодня", "кофе", "принтер", "отпуск", "обучение", "заказ", "клиент", "ёлка",
            "город", "книга"),
            List.of("Отдел продаж", "Бухгалтерия", "Служба поддержки", "Секретариат"), ".", true);

    static final Lang EL = new Lang("el", List.of(
            "συνάντηση", "αύριο", "προϋπολογισμός", "αναφορά", "έργο", "τιμολόγιο", "ομάδα", "γραφείο", "κήπος", "καιρός",
            "ευχαριστώ", "παρακαλώ", "εβδομάδα", "επόμενη", "σύμβαση", "παράδοση", "πρόγραμμα", "ερώτηση", "και", "για",
            "με", "στο", "την", "σήμερα", "καφές", "εκτυπωτής", "διακοπές", "εκπαίδευση", "παραγγελία", "πελάτης", "πόλη",
            "βιβλίο"),
            List.of("Τμήμα πωλήσεων", "Λογιστήριο", "Εξυπηρέτηση πελατών", "Γραμματεία"), ".", true);

    static final Lang HE = new Lang("he", List.of(
            "פגישה", "מחר", "תקציב", "דוח", "פרויקט", "חשבונית", "צוות", "משרד", "גינה", "מזג", "אוויר", "תודה", "בבקשה",
            "שבוע", "הבא", "חוזה", "משלוח", "לוח", "זמנים", "שאלה", "של", "עם", "על", "את", "היום", "קפה", "מדפסת", "חופשה",
            "הדרכה", "הזמנה", "לקוח", "ספר", "עיר"),
            List.of("שירות לקוחות", "הנהלת חשבונות", "מזכירות", "צוות מכירות"), ".", false);

    static final Lang AR = new Lang("ar", List.of(
            "اجتماع", "غدا", "ميزانية", "تقرير", "مشروع", "فاتورة", "فريق", "مكتب", "حديقة", "الطقس", "شكرا", "الأسبوع",
            "القادم", "عقد", "التسليم", "جدول", "سؤال", "في", "من", "على", "مع", "اليوم", "قهوة", "طابعة", "إجازة", "تدريب",
            "طلب", "عميل", "كتاب", "مدينة", "الموظفين", "الاجتماع"),
            List.of("خدمة العملاء", "قسم المحاسبة", "السكرتارية", "فريق المبيعات"), ".", false);

    static final Lang ZH_HANS = new Lang("zh-Hans", List.of(
            "会议", "明天", "预算", "报告", "项目", "发票", "团队", "办公室", "花园", "天气", "谢谢", "下周", "合同", "交付",
            "时间表", "问题", "经理", "客户", "计划", "通知", "项目经理", "工作计划", "年度预算", "会议纪要", "客户服务",
            "市场营销", "产品发布", "技术支持", "财务报告", "人力资源", "我们", "已经", "请", "的", "在"),
            List.of("客户服务", "财务部", "人力资源部", "市场部"), "。", false);

    static final Lang ZH_HANT = new Lang("zh-Hant", List.of(
            "會議", "明天", "預算", "報告", "項目", "發票", "團隊", "辦公室", "花園", "天氣", "謝謝", "下週", "合約", "交付",
            "時間表", "問題", "經理", "客戶", "計劃", "通知", "專案經理", "工作計劃", "年度預算", "會議記錄", "客戶服務",
            "市場行銷", "產品發表", "技術支援", "財務報告", "人力資源", "我們", "已經", "請", "的", "在"),
            List.of("客戶服務", "財務部", "人力資源部", "行銷部"), "。", false);

    static final Lang JA = new Lang("ja", List.of(
            "会議", "明日", "予算", "報告書", "案件", "請求書", "事務所", "天気", "来週", "契約", "納品", "スケジュール",
            "プロジェクト", "ミーティング", "レポート", "チーム", "オフィス", "コーヒー", "サンプル", "メンバー",
            "データベース", "打ち合わせ", "資料作成", "会議資料", "予定変更", "営業会議", "よろしく", "お願いします", "です",
            "ます", "について"),
            List.of("営業部", "総務部", "経理部", "カスタマーサポート"), "。", false);

    static final Lang KO = new Lang("ko", List.of(
            "회의", "내일", "예산", "보고서", "프로젝트", "청구서", "사무실", "날씨", "감사합니다", "다음주", "계약서", "배송",
            "일정표", "질문", "회의록", "고객센터", "마케팅", "데이터베이스", "오늘", "커피", "프린터", "휴가", "교육", "주문",
            "고객", "도서관", "그리고", "에서", "입니다"),
            List.of("고객센터", "회계팀", "인사팀", "영업팀"), ".", false);

    static final List<Lang> ALL = List.of(EN, FR, DE, ES, PL, CS, TR, RU, EL, HE, AR, ZH_HANS, ZH_HANT, JA, KO);
    /** Languages written in Latin letters with a few accents: for families that aren't about charsets. */
    static final List<Lang> LATIN = List.of(EN, FR, DE, ES, PL, CS, TR);

    /** How a charset's body may go on the wire. */
    enum Wire {
        /** Bytes over 127: 8bit, quoted-printable or base64. */
        EIGHT_BIT,
        /** Seven-bit text: 7bit or quoted-printable. */
        SEVEN_BIT,
        /** Seven-bit with escapes (ISO-2022-JP): 7bit or base64, B words only. */
        ESCAPED,
        /** UTF-16, with NULs: base64 only, a BOM in front, subject in UTF-8. */
        UTF16
    }

    /** A charset as labeled on the wire, the Java charset that writes it, the languages it carries, and its wire. */
    record Cs(String label, Charset charset, List<Lang> langs, Wire wire, String bom) {
    }

    static final List<Cs> CHARSETS = List.of(
            new Cs("utf-8", Charset.forName("UTF-8"), ALL, Wire.EIGHT_BIT, null),
            new Cs("us-ascii", Charset.forName("US-ASCII"), List.of(EN), Wire.SEVEN_BIT, null),
            new Cs("iso-8859-1", Charset.forName("ISO-8859-1"), List.of(FR, DE, ES), Wire.EIGHT_BIT, null),
            new Cs("iso-8859-2", Charset.forName("ISO-8859-2"), List.of(PL, CS, DE), Wire.EIGHT_BIT, null),
            new Cs("iso-8859-5", Charset.forName("ISO-8859-5"), List.of(RU), Wire.EIGHT_BIT, null),
            new Cs("iso-8859-7", Charset.forName("ISO-8859-7"), List.of(EL), Wire.EIGHT_BIT, null),
            new Cs("iso-8859-9", Charset.forName("ISO-8859-9"), List.of(TR), Wire.EIGHT_BIT, null),
            new Cs("iso-8859-15", Charset.forName("ISO-8859-15"), List.of(FR, DE, ES), Wire.EIGHT_BIT, null),
            new Cs("windows-1250", Charset.forName("windows-1250"), List.of(PL, CS), Wire.EIGHT_BIT, null),
            new Cs("windows-1251", Charset.forName("windows-1251"), List.of(RU), Wire.EIGHT_BIT, null),
            new Cs("windows-1252", Charset.forName("windows-1252"), List.of(EN, FR, DE, ES), Wire.EIGHT_BIT, null),
            new Cs("windows-1253", Charset.forName("windows-1253"), List.of(EL), Wire.EIGHT_BIT, null),
            new Cs("windows-1255", Charset.forName("windows-1255"), List.of(HE), Wire.EIGHT_BIT, null),
            new Cs("windows-1256", Charset.forName("windows-1256"), List.of(AR), Wire.EIGHT_BIT, null),
            new Cs("koi8-r", Charset.forName("KOI8-R"), List.of(RU), Wire.EIGHT_BIT, null),
            new Cs("big5", Charset.forName("Big5"), List.of(ZH_HANT), Wire.EIGHT_BIT, null),
            new Cs("gb2312", Charset.forName("GB2312"), List.of(ZH_HANS), Wire.EIGHT_BIT, null),
            new Cs("gbk", Charset.forName("GBK"), List.of(ZH_HANS), Wire.EIGHT_BIT, null),
            new Cs("gb18030", Charset.forName("GB18030"), List.of(ZH_HANS, ZH_HANT), Wire.EIGHT_BIT, null),
            new Cs("shift_jis", Charset.forName("Shift_JIS"), List.of(JA), Wire.EIGHT_BIT, null),
            new Cs("euc-jp", Charset.forName("EUC-JP"), List.of(JA), Wire.EIGHT_BIT, null),
            new Cs("iso-2022-jp", Charset.forName("ISO-2022-JP"), List.of(JA), Wire.ESCAPED, null),
            new Cs("euc-kr", Charset.forName("EUC-KR"), List.of(KO), Wire.EIGHT_BIT, null),
            // UTF-16 with a byte order mark, labeled plainly or by its order, as senders do both.
            new Cs("utf-16", Charset.forName("UTF-16LE"), ALL, Wire.UTF16, "LE"),
            new Cs("utf-16", Charset.forName("UTF-16BE"), ALL, Wire.UTF16, "BE"),
            new Cs("utf-16le", Charset.forName("UTF-16LE"), ALL, Wire.UTF16, "LE"),
            new Cs("utf-16be", Charset.forName("UTF-16BE"), ALL, Wire.UTF16, "BE"));

    /** The first charset of that label. */
    static Cs cs(String label) {
        for (Cs cs : CHARSETS) {
            if (cs.label().equals(label)) {
                return cs;
            }
        }
        throw new IllegalArgumentException(label);
    }
}
