package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/minimalist-alliance/ma-desk/apps/bible/internal/canon"
	"github.com/minimalist-alliance/ma-desk/apps/bible/internal/store"
	"github.com/minimalist-alliance/ma-desk/apps/bible/internal/text"
	"github.com/minimalist-alliance/ma-desk/apps/bible/internal/wire"
)

// The methods of API.md, each a read or a mutation as ma-app.json declares.

const (
	maxReply     = 256 << 10
	defaultLimit = 50
	maxLimit     = 200
	summaryCut   = 120
)

type apiErr struct {
	code, reason, msg string
}

func (e *apiErr) wire() wire.Error {
	w := wire.Error{Code: e.code, Message: e.msg}
	if e.reason != "" {
		w.Details = map[string]any{"reason": e.reason}
	}
	if e.code == "internal" {
		w.Message = "Internal error"
	}
	return w
}

func bad(reason string) *apiErr { return &apiErr{"bad_request", reason, "bad " + reason} }

func notFound(reason string) *apiErr { return &apiErr{"not_found", reason, "no such " + reason} }

func unavailable(reason string) *apiErr {
	return &apiErr{"unavailable", reason, reason + " unavailable"}
}

// params decodes p into v; a field of the wrong type is bad_request with that field's name.
func params(raw json.RawMessage, v any) *apiErr {
	if len(raw) == 0 || string(raw) == "null" {
		raw = json.RawMessage("{}")
	}
	if err := json.Unmarshal(raw, v); err != nil {
		var te *json.UnmarshalTypeError
		if errors.As(err, &te) && te.Field != "" {
			return bad(te.Field)
		}
		return bad("p")
	}
	return nil
}

// caller is who a call is for, as deskd says (deskd API.md §19, "What the app is told about the caller").
type caller struct {
	Kind   string `json:"kind"`
	Member string `json:"member"`
}

// request is a REQ from deskd.
type request struct {
	M          string          `json:"m"`
	P          json.RawMessage `json:"p"`
	Idem       string          `json:"idem"`
	DeadlineMs int             `json:"deadlineMs"`
	From       struct {
		Kind   string  `json:"kind"`
		Caller *caller `json:"caller"`
	} `json:"from"`
}

var memberID = regexp.MustCompile(`^p-[A-Za-z0-9_-]{22}$`)

// whose is the bucket a call's data belongs to: the owner's on a member's own desk, a member's pseudonym on a Guild
// Desk, or store.Desk for deskd's own calls. Anything else is forbidden.
func whose(fromKind string, c *caller) (string, *apiErr) {
	if fromKind == "desk" {
		return store.Desk, nil
	}
	if c != nil {
		switch {
		case c.Kind == "owner":
			return store.Owner, nil
		case c.Kind == "guild_member" && memberID.MatchString(c.Member):
			return c.Member, nil
		}
	}
	return "", &apiErr{"forbidden", "caller", "no caller this app knows"}
}

// panicOn makes one method panic, for the test that a panic stays inside its call.
var panicOn string

func (a *app) dispatch(ctx context.Context, r *request, who string) (any, *apiErr) {
	if panicOn != "" && r.M == panicOn {
		panic("a test's panic")
	}
	if r.M == "app.members.retain" {
		if who != store.Desk {
			return nil, &apiErr{"forbidden", "caller", "deskd's call"}
		}
		return a.retain(ctx, r)
	}
	if who == store.Desk {
		return nil, &apiErr{"forbidden", "caller", "a view's call"}
	}
	switch r.M {
	case "bible.state":
		return a.state(ctx, who)
	case "bible.info":
		return map[string]any{"translations": a.infos(), "defaultTranslation": text.DefaultCode}, nil
	case "bible.about":
		return a.about(r.P)
	case "bible.books":
		return a.books(r.P)
	case "bible.chapter":
		return a.chapter(ctx, r.P, who)
	case "bible.lookup":
		return a.lookup(r.P)
	case "bible.search":
		return a.search(ctx, r.P)
	case "bible.marks.chapter":
		return a.marksChapter(ctx, r.P, who)
	case "bible.marks.list":
		return a.marksList(ctx, r.P, who)
	case "bible.mark.put", "bible.mark.remove", "bible.highlight.clear", "bible.prefs.set":
		return a.mutation(ctx, r, who)
	case "bible.prefs.get":
		st, aerr := a.waitStore(ctx)
		if aerr != nil {
			return nil, aerr
		}
		return st.Prefs(who), nil
	}
	return nil, notFound("method")
}

func (a *app) waitStore(ctx context.Context) (*store.Store, *apiErr) {
	select {
	case <-a.ready:
	case <-ctx.Done():
		return nil, unavailable("starting")
	}
	if a.st == nil {
		return nil, unavailable("data")
	}
	return a.st, nil
}

func (a *app) infos() []text.Info {
	out := []text.Info{}
	for _, c := range a.lib.Codes() {
		out = append(out, a.lib.Info(c))
	}
	return out
}

// translation reads one by its code: bad_request if there's none, not_found if it isn't in the package, unavailable if
// it can't be read.
func (a *app) translation(code string) (*text.Translation, *apiErr) {
	if code == "" {
		return nil, bad("translation")
	}
	t, err := a.lib.Get(code)
	switch {
	case errors.Is(err, text.ErrUnknown):
		return nil, notFound("translation")
	case err != nil:
		return nil, unavailable("translation")
	}
	return t, nil
}

type bookJSON struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Testament string `json:"testament"`
	Chapters  int    `json:"chapters"`
	Verses    []int  `json:"verses"`
}

func booksOf(t *text.Translation) []bookJSON {
	out := []bookJSON{}
	for _, b := range t.Books() {
		out = append(out, bookJSON{ID: b.ID, Name: b.Name, Testament: canon.Books[b.Canon].Testament, Chapters: b.Chapters, Verses: b.Verses()})
	}
	return out
}

func (a *app) state(ctx context.Context, who string) (any, *apiErr) {
	st, aerr := a.waitStore(ctx)
	if aerr != nil {
		return nil, aerr
	}
	prefs := st.Prefs(who)
	try := []string{text.DefaultCode}
	if prefs.Place != nil {
		try = append([]string{prefs.Place.Translation}, try...)
	}
	try = append(try, a.lib.Codes()...)
	res := map[string]any{"available": false, "reason": "texts", "translations": a.infos(), "defaultTranslation": text.DefaultCode,
		"translation": "", "books": []bookJSON{}, "prefs": prefs}
	for _, c := range try {
		if t, err := a.lib.Get(c); err == nil {
			res["available"], res["translation"], res["books"] = true, c, booksOf(t)
			delete(res, "reason")
			break
		}
	}
	return res, nil
}

func (a *app) about(raw json.RawMessage) (any, *apiErr) {
	var p struct {
		Translation string `json:"translation"`
	}
	if aerr := params(raw, &p); aerr != nil {
		return nil, aerr
	}
	if p.Translation == "" {
		return nil, bad("translation")
	}
	if !a.lib.Has(p.Translation) {
		return nil, notFound("translation")
	}
	statement, err1 := a.lib.File(p.Translation, "NOTICE.txt") // the member-facing notice; STATEMENT.txt is the audit record
	source, err2 := a.lib.File(p.Translation, "SOURCE.md")
	if err1 != nil || err2 != nil {
		return nil, unavailable("translation")
	}
	i := a.lib.Info(p.Translation)
	var url any
	if i.SourceURL != "" {
		url = i.SourceURL
	}
	return map[string]any{"code": i.Code, "name": i.Name, "abbreviation": i.Abbreviation, "edition": i.Edition,
		"statement": statement, "source": source, "sourceUrl": url}, nil
}

func (a *app) books(raw json.RawMessage) (any, *apiErr) {
	var p struct {
		Translation string `json:"translation"`
	}
	if aerr := params(raw, &p); aerr != nil {
		return nil, aerr
	}
	t, aerr := a.translation(p.Translation)
	if aerr != nil {
		return nil, aerr
	}
	return map[string]any{"translation": t.Code, "books": booksOf(t)}, nil
}

func (a *app) chapter(ctx context.Context, raw json.RawMessage, who string) (any, *apiErr) {
	var p struct {
		Translation string `json:"translation"`
		Book        string `json:"book"`
		Chapter     int    `json:"chapter"`
	}
	if aerr := params(raw, &p); aerr != nil {
		return nil, aerr
	}
	t, aerr := a.translation(p.Translation)
	if aerr != nil {
		return nil, aerr
	}
	if p.Book == "" {
		return nil, bad("book")
	}
	b := t.Book(p.Book)
	if b == nil {
		return nil, notFound("book")
	}
	items, ok := t.Chapter(b, p.Chapter)
	if !ok {
		return nil, notFound("chapter")
	}
	prev, next := t.Neighbors(b, p.Chapter)
	marks := []store.Mark{}
	if st, aerr := a.waitStore(ctx); aerr == nil {
		if ms, err := st.Chapter(who, b.ID, p.Chapter); err == nil {
			marks = ms
		} else {
			log.Printf("a chapter's marks: %v", err) // the text still shows
		}
	}
	return map[string]any{"translation": t.Code, "book": b.ID, "bookName": b.Name, "chapter": p.Chapter, "items": items,
		"prev": prev, "next": next, "marks": marks}, nil
}

func (a *app) lookup(raw json.RawMessage) (any, *apiErr) {
	var p struct {
		Q           string `json:"q"`
		Translation string `json:"translation"`
	}
	if aerr := params(raw, &p); aerr != nil {
		return nil, aerr
	}
	if strings.TrimSpace(p.Q) == "" || utf8.RuneCountInString(p.Q) > text.MaxQueryChars {
		return nil, bad("q")
	}
	if p.Translation == "" {
		p.Translation = text.DefaultCode
	}
	t, aerr := a.translation(p.Translation)
	if aerr != nil {
		return nil, aerr
	}
	ref, ok := t.Lookup(p.Q)
	if !ok {
		return nil, notFound("ref")
	}
	return map[string]any{"ref": ref}, nil
}

// searchCursor is opaque to the view: the last hit's place, and which search it belongs to.
type searchCursor struct {
	V int    `json:"v"`
	H string `json:"h"`
	K [4]int `json:"k"`
}

func encodeCursor(v any) string {
	b, _ := json.Marshal(v)
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeCursor(s string, v any) bool {
	b, err := base64.RawURLEncoding.DecodeString(s)
	return err == nil && json.Unmarshal(b, v) == nil
}

func (a *app) search(ctx context.Context, raw json.RawMessage) (any, *apiErr) {
	var p struct {
		Translation string `json:"translation"`
		Q           string `json:"q"`
		Scope       string `json:"scope"`
		Cursor      string `json:"cursor"`
		Limit       *int   `json:"limit"`
	}
	if aerr := params(raw, &p); aerr != nil {
		return nil, aerr
	}
	if p.Scope == "" {
		p.Scope = "all"
	}
	if !text.ValidScope(p.Scope) {
		return nil, bad("scope")
	}
	limit := defaultLimit
	if p.Limit != nil {
		if *p.Limit < 1 || *p.Limit > maxLimit {
			return nil, bad("limit")
		}
		limit = *p.Limit
	}
	q, err := text.ParseQuery(p.Q)
	if err != nil {
		return nil, bad("q")
	}
	var trs []*text.Translation
	if p.Translation == "all" {
		for _, c := range a.lib.Codes() {
			if t, err := a.lib.Get(c); err == nil {
				trs = append(trs, t) // one that can't be read is left out; the others still work
			}
		}
		if len(trs) == 0 {
			return nil, unavailable("translation")
		}
	} else {
		t, aerr := a.translation(p.Translation)
		if aerr != nil {
			return nil, aerr
		}
		trs = []*text.Translation{t}
	}
	hash := text.QueryHash(p.Translation, p.Scope, q)
	var after *text.Key
	if p.Cursor != "" {
		var c searchCursor
		if !decodeCursor(p.Cursor, &c) || c.V != 1 || c.H != hash {
			return nil, bad("cursor")
		}
		after = &text.Key{Book: c.K[0], Chapter: c.K[1], Verse: c.K[2], T: c.K[3]}
	}
	res, err := text.Search(ctx, text.SearchParams{Translations: trs, Scope: p.Scope, Query: q, After: after, Limit: limit, MaxBytes: maxReply - 16<<10})
	if err != nil {
		return nil, ctxErr(ctx)
	}
	out := map[string]any{"hits": res.Hits, "total": res.Total, "counts": res.Counts, "byBook": res.ByBook, "cursor": nil}
	if res.Hits == nil {
		out["hits"] = []text.Hit{}
	}
	if res.ByBook == nil {
		out["byBook"] = []text.BookCount{}
	}
	if res.More {
		k := res.Last
		out["cursor"] = encodeCursor(searchCursor{V: 1, H: hash, K: [4]int{k.Book, k.Chapter, k.Verse, k.T}})
	}
	if ref, ok := trs[0].LookupStrict(p.Q); ok {
		out["ref"] = ref
	}
	return out, nil
}

func (a *app) marksChapter(ctx context.Context, raw json.RawMessage, who string) (any, *apiErr) {
	var p struct {
		Book    string `json:"book"`
		Chapter int    `json:"chapter"`
	}
	if aerr := params(raw, &p); aerr != nil {
		return nil, aerr
	}
	bi, ok := canon.Index(p.Book)
	if !ok {
		return nil, bad("book")
	}
	if p.Chapter < 1 || p.Chapter > canon.Books[bi].Chapters {
		return nil, bad("chapter")
	}
	st, aerr := a.waitStore(ctx)
	if aerr != nil {
		return nil, aerr
	}
	marks, err := st.Chapter(who, p.Book, p.Chapter)
	if err != nil {
		log.Printf("marks: %v", err)
		return nil, unavailable("data")
	}
	return map[string]any{"marks": marks}, nil
}

type listedMark struct {
	store.Mark
	VerseText *string `json:"verseText,omitempty"`
}

func (a *app) marksList(ctx context.Context, raw json.RawMessage, who string) (any, *apiErr) {
	var p struct {
		Kind        string `json:"kind"`
		Order       string `json:"order"`
		Cursor      string `json:"cursor"`
		Limit       *int   `json:"limit"`
		Translation string `json:"translation"`
	}
	if aerr := params(raw, &p); aerr != nil {
		return nil, aerr
	}
	if p.Kind != "" && p.Kind != "bookmark" && p.Kind != "highlight" && p.Kind != "note" {
		return nil, bad("kind")
	}
	if p.Order == "" {
		p.Order = "canon"
	}
	if p.Order != "canon" && p.Order != "recent" {
		return nil, bad("order")
	}
	limit := defaultLimit
	if p.Limit != nil {
		if *p.Limit < 1 || *p.Limit > maxLimit {
			return nil, bad("limit")
		}
		limit = *p.Limit
	}
	var after *store.Cursor
	if p.Cursor != "" {
		var c store.Cursor
		if !decodeCursor(p.Cursor, &c) || c.Order != p.Order || c.Kind != p.Kind {
			return nil, bad("cursor")
		}
		after = &c
	}
	var t *text.Translation
	if p.Translation != "" {
		var aerr *apiErr
		if t, aerr = a.translation(p.Translation); aerr != nil {
			return nil, aerr
		}
	}
	st, aerr := a.waitStore(ctx)
	if aerr != nil {
		return nil, aerr
	}
	marks, total, next, err := st.List(who, p.Kind, p.Order, after, limit)
	if err != nil {
		var inv *store.Invalid
		if errors.As(err, &inv) {
			return nil, bad(inv.Reason)
		}
		log.Printf("marks: %v", err)
		return nil, unavailable("data")
	}
	out := make([]listedMark, len(marks))
	for i, m := range marks {
		out[i].Mark = m
		if t != nil {
			s, _ := t.VerseText(m.Book, m.Chapter, m.Verse)
			s = cut(s, summaryCut)
			out[i].VerseText = &s
		}
	}
	var cursor any
	if next != nil {
		cursor = encodeCursor(next)
	}
	return map[string]any{"marks": out, "total": total, "cursor": cursor}, nil
}

func (a *app) mutation(ctx context.Context, r *request, who string) (any, *apiErr) {
	st, aerr := a.waitStore(ctx)
	if aerr != nil {
		return nil, aerr
	}
	var res json.RawMessage
	var changed bool
	var err error
	switch r.M {
	case "bible.mark.put":
		var p struct {
			Mark *store.MarkInput `json:"mark"`
		}
		if aerr := params(r.P, &p); aerr != nil {
			if aerr.reason != "p" {
				aerr.reason = strings.TrimPrefix(aerr.reason, "mark.")
			}
			return nil, aerr
		}
		if p.Mark == nil {
			return nil, bad("mark")
		}
		res, changed, err = st.PutMark(who, r.Idem, *p.Mark)
	case "bible.mark.remove":
		var p struct {
			ID string `json:"id"`
		}
		if aerr := params(r.P, &p); aerr != nil {
			return nil, aerr
		}
		if p.ID == "" {
			return nil, bad("id")
		}
		res, changed, err = st.RemoveMark(who, r.Idem, p.ID)
	case "bible.highlight.clear":
		var p struct {
			Book     string `json:"book"`
			Chapter  int    `json:"chapter"`
			Verse    int    `json:"verse"`
			VerseEnd int    `json:"verseEnd"`
		}
		if aerr := params(r.P, &p); aerr != nil {
			return nil, aerr
		}
		res, changed, err = st.ClearHighlights(who, r.Idem, p.Book, p.Chapter, p.Verse, p.VerseEnd)
	case "bible.prefs.set":
		var p map[string]json.RawMessage
		if aerr := params(r.P, &p); aerr != nil {
			return nil, aerr
		}
		res, err = st.SetPrefs(who, r.Idem, p)
		if err == nil && who == store.Owner {
			a.publishSummary()
		}
	}
	if err != nil {
		return nil, storeErr(err)
	}
	if changed {
		a.marksChanged(who)
	}
	return res, nil
}

// retain is deskd's app.members.retain: every member's data not in the list goes (API.md, "Guild Desks").
func (a *app) retain(ctx context.Context, r *request) (any, *apiErr) {
	var p struct {
		Members *[]string `json:"members"`
		All     bool      `json:"all"`
	}
	if aerr := params(r.P, &p); aerr != nil {
		return nil, aerr
	}
	if p.Members == nil && !p.All {
		return nil, bad("members")
	}
	var members []string
	if p.Members != nil {
		members = *p.Members
	}
	st, aerr := a.waitStore(ctx)
	if aerr != nil {
		return nil, aerr
	}
	res, err := st.Retain(r.Idem, members, p.All)
	if err != nil {
		return nil, storeErr(err)
	}
	return res, nil
}

func storeErr(err error) *apiErr {
	var inv *store.Invalid
	var nf *store.NotFound
	switch {
	case errors.As(err, &inv):
		return bad(inv.Reason)
	case errors.As(err, &nf):
		return notFound(nf.Reason)
	case errors.Is(err, store.ErrFull):
		return &apiErr{"precondition_failed", "full", "the marks are full"}
	case errors.Is(err, store.ErrIdem):
		return &apiErr{"conflict", "idem", "that idem key was used for another method"}
	case errors.Is(err, store.ErrDisk):
		return unavailable("disk")
	}
	return &apiErr{code: "internal"}
}

// summaryJSON is the widget's app.summary: nothing before a place exists, then the place and its verse's first words.
// On a Guild Desk, or before deskd has said which kind of desk this is, nothing: a shared tile never shows one
// member's place.
func (a *app) summaryJSON() []byte {
	rows := []map[string]string{}
	select {
	case <-a.ready:
		if a.st != nil && a.guild.Load() == 0 {
			if pl := a.st.Prefs(store.Owner).Place; pl != nil {
				if t, err := a.lib.Get(pl.Translation); err == nil {
					name := pl.Book
					if b := t.Book(pl.Book); b != nil {
						name = b.Name
					} else if i, ok := canon.Index(pl.Book); ok {
						name = canon.Books[i].Name
					}
					row := map[string]string{"text": name + " " + strconv.Itoa(pl.Chapter) + ":" + strconv.Itoa(pl.Verse) + " · " + t.Abbreviation}
					if s, ok := t.VerseText(pl.Book, pl.Chapter, pl.Verse); ok && s != "" {
						row["detail"] = cut(s, summaryCut)
					}
					rows = append(rows, row)
				}
			}
		}
	default:
	}
	b, _ := json.Marshal(map[string]any{"rows": rows})
	return b
}

// cut shortens s to at most n UTF-16 units, at a word, ending with "…".
func cut(s string, n int) string {
	if len(utf16.Encode([]rune(s))) <= n {
		return s
	}
	units, end := 0, 0
	for i, r := range s {
		w := utf16.RuneLen(r)
		if units+w > n-1 {
			break
		}
		units += w
		end = i + utf8.RuneLen(r)
	}
	head := s[:end]
	if sp := strings.LastIndexByte(head, ' '); sp > n/2 {
		head = head[:sp]
	}
	return strings.TrimRight(head, " ,;:.—–-") + "…"
}
