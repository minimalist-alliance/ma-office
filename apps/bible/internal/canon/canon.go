// Package canon is the 66 books of the Protestant canon by their USFM ids, in canonical order, with their
// English chapter counts. Marks are checked against it, never against one translation, because a mark
// belongs to a verse and shows in every translation.
package canon

// Book is one book of the canon.
type Book struct {
	ID        string // USFM id, such as "JHN"
	Name      string // English name, such as "John"
	Testament string // "ot" or "nt"
	Chapters  int
}

// MaxVerse is the highest verse number in any chapter (Psalm 119:176).
const MaxVerse = 176

// Books in canonical order.
var Books = []Book{
	{"GEN", "Genesis", "ot", 50}, {"EXO", "Exodus", "ot", 40}, {"LEV", "Leviticus", "ot", 27},
	{"NUM", "Numbers", "ot", 36}, {"DEU", "Deuteronomy", "ot", 34}, {"JOS", "Joshua", "ot", 24},
	{"JDG", "Judges", "ot", 21}, {"RUT", "Ruth", "ot", 4}, {"1SA", "1 Samuel", "ot", 31},
	{"2SA", "2 Samuel", "ot", 24}, {"1KI", "1 Kings", "ot", 22}, {"2KI", "2 Kings", "ot", 25},
	{"1CH", "1 Chronicles", "ot", 29}, {"2CH", "2 Chronicles", "ot", 36}, {"EZR", "Ezra", "ot", 10},
	{"NEH", "Nehemiah", "ot", 13}, {"EST", "Esther", "ot", 10}, {"JOB", "Job", "ot", 42},
	{"PSA", "Psalms", "ot", 150}, {"PRO", "Proverbs", "ot", 31}, {"ECC", "Ecclesiastes", "ot", 12},
	{"SNG", "Song of Solomon", "ot", 8}, {"ISA", "Isaiah", "ot", 66}, {"JER", "Jeremiah", "ot", 52},
	{"LAM", "Lamentations", "ot", 5}, {"EZK", "Ezekiel", "ot", 48}, {"DAN", "Daniel", "ot", 12},
	{"HOS", "Hosea", "ot", 14}, {"JOL", "Joel", "ot", 3}, {"AMO", "Amos", "ot", 9},
	{"OBA", "Obadiah", "ot", 1}, {"JON", "Jonah", "ot", 4}, {"MIC", "Micah", "ot", 7},
	{"NAM", "Nahum", "ot", 3}, {"HAB", "Habakkuk", "ot", 3}, {"ZEP", "Zephaniah", "ot", 3},
	{"HAG", "Haggai", "ot", 2}, {"ZEC", "Zechariah", "ot", 14}, {"MAL", "Malachi", "ot", 4},
	{"MAT", "Matthew", "nt", 28}, {"MRK", "Mark", "nt", 16}, {"LUK", "Luke", "nt", 24},
	{"JHN", "John", "nt", 21}, {"ACT", "Acts", "nt", 28}, {"ROM", "Romans", "nt", 16},
	{"1CO", "1 Corinthians", "nt", 16}, {"2CO", "2 Corinthians", "nt", 13}, {"GAL", "Galatians", "nt", 6},
	{"EPH", "Ephesians", "nt", 6}, {"PHP", "Philippians", "nt", 4}, {"COL", "Colossians", "nt", 4},
	{"1TH", "1 Thessalonians", "nt", 5}, {"2TH", "2 Thessalonians", "nt", 3}, {"1TI", "1 Timothy", "nt", 6},
	{"2TI", "2 Timothy", "nt", 4}, {"TIT", "Titus", "nt", 3}, {"PHM", "Philemon", "nt", 1},
	{"HEB", "Hebrews", "nt", 13}, {"JAS", "James", "nt", 5}, {"1PE", "1 Peter", "nt", 5},
	{"2PE", "2 Peter", "nt", 3}, {"1JN", "1 John", "nt", 5}, {"2JN", "2 John", "nt", 1},
	{"3JN", "3 John", "nt", 1}, {"JUD", "Jude", "nt", 1}, {"REV", "Revelation", "nt", 22},
}

var index = func() map[string]int {
	m := make(map[string]int, len(Books))
	for i, b := range Books {
		m[b.ID] = i
	}
	return m
}()

// Index returns a book's place in the canon (0 for Genesis), or false for anything that isn't a USFM id.
func Index(id string) (int, bool) {
	i, ok := index[id]
	return i, ok
}

// Valid says whether book, chapter and verse can exist: a known id, a chapter of that book, a verse of 1 to MaxVerse.
func Valid(book string, chapter, verse int) bool {
	i, ok := index[book]
	return ok && chapter >= 1 && chapter <= Books[i].Chapters && verse >= 1 && verse <= MaxVerse
}

// Translations in their fixed order: BSB first, the default.
var Translations = []string{"bsb", "web", "kjv", "asv"}

// TranslationOrder returns a code's place in Translations, or -1.
func TranslationOrder(code string) int {
	for i, c := range Translations {
		if c == code {
			return i
		}
	}
	return -1
}

// Colors a highlight may have, by name: the Notebook's names, so both apps mean the same thing.
var Colors = []string{"amber", "green", "blue", "rose"}

// ValidColor says whether c is one of Colors.
func ValidColor(c string) bool {
	for _, x := range Colors {
		if x == c {
			return true
		}
	}
	return false
}
