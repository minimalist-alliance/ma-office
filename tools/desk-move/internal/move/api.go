package move

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/client"
)

// Claim is POST /v1/moves/claim's answer (ma-platform draft, section 4).
type Claim struct {
	MoveID       string `json:"moveId"`
	MoveToken    string `json:"moveToken"`
	SourceDeskID string `json:"sourceDeskId"`
	TargetDeskID string `json:"targetDeskId"`
	SourceName   string `json:"sourceName"`
	TargetName   string `json:"targetName"`
	ExpiresAt    string `json:"expiresAt"`
}

// PlatformReport is POST /v1/moves/{moveId}/report's body: counts only, never a name or a path.
type PlatformReport struct {
	State  string       `json:"state"`
	Parts  int          `json:"parts"`
	Files  int          `json:"files"`
	Bytes  int64        `json:"bytes"`
	Checks ReportChecks `json:"checks"`
	Error  string       `json:"error,omitempty"` // one of ReportErrors, with state failed only
}

// ReportChecks counts the checks that passed and failed.
type ReportChecks struct {
	Passed int `json:"passed"`
	Failed int `json:"failed"`
}

// ReportErrors is the platform's list (ma-platform services/desks/src/moves.ts, REPORT_ERRORS).
var ReportErrors = []string{
	"target_mismatch", "chromium_older", "password_store", "helper_unavailable", "copy_failed", "checksum_mismatch",
	"disk_full", "swap_failed", "cookies_unreadable", "connection_lost", "interrupted", "other",
}

// API is the platform's moves routes.
type API interface {
	Claim(ctx context.Context, code, targetDeskID string, proof *ClaimProof) (*Claim, error)
	Connect(ctx context.Context, moveID, token, fingerprint string, start bool) (*client.ConnectReply, error)
	Report(ctx context.Context, moveID, token string, r PlatformReport) error
}

// APIError is a non-2xx answer.
type APIError struct {
	Status  int
	Code    string
	Message string
}

func (e *APIError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("HTTP %d %s", e.Status, e.Code)
	}

	return fmt.Sprintf("HTTP %d", e.Status)
}

// moveEnded reports whether the platform says this move can't go on: its token is no longer good (401), the
// member or the desk can't be opened (403), there's no such move (404), or it's done or cancelled (409
// move_ended).
func moveEnded(err error) bool {
	var e *APIError
	if !errors.As(err, &e) {
		return false
	}
	switch e.Status {
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusGone:
		return true
	case http.StatusConflict:
		return e.Code == "move_ended"
	}

	return false
}

// permanentAPI is any other refusal that trying again won't change. A 409 invalid_state (the cloud desk is
// stopping) and 429 are worth waiting out, as is anything 5xx.
func permanentAPI(err error) bool {
	var e *APIError
	if !errors.As(err, &e) || e.Status/100 != 4 {
		return false
	}

	return !(e.Status == http.StatusConflict && e.Code == "invalid_state") && e.Status != http.StatusTooManyRequests
}

// HTTPAPI talks to api.minimalistalliance.com (or staging).
type HTTPAPI struct {
	Base   string
	Client *http.Client
}

func (h *HTTPAPI) do(ctx context.Context, path, auth string, in, out any) error {
	body, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(h.Base, "/")+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "ma-move/"+Version)
	if auth != "" {
		req.Header.Set("Authorization", "Move "+auth)
	}
	hc := h.Client
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode/100 != 2 {
		e := &APIError{Status: resp.StatusCode}
		var b struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Error   *struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &b) == nil {
			e.Code, e.Message = b.Code, b.Message
			if b.Error != nil {
				e.Code, e.Message = b.Error.Code, b.Error.Message
			}
		}

		return e
	}
	if out == nil {
		return nil
	}

	return json.Unmarshal(data, out)
}

// Claim redeems the one-time code. It needs no sign-in: the code is the credential.
// With the target desk's signature (`proof`, EXP-1) it is the code and the key together.
func (h *HTTPAPI) Claim(ctx context.Context, code, targetDeskID string, proof *ClaimProof) (*Claim, error) {
	body := map[string]any{"code": code, "targetDeskId": targetDeskID}
	if proof != nil {
		body["targetKey"] = proof
	}
	var c Claim
	if err := h.do(ctx, "/v1/moves/claim", "", body, &c); err != nil {
		return nil, err
	}
	if c.MoveID == "" || c.MoveToken == "" || c.SourceDeskID == "" {
		return nil, errors.New("claim: the answer is missing moveId, moveToken or sourceDeskId")
	}

	return &c, nil
}

// Connect asks for an export-scope desk token for the move's cloud desk.
func (h *HTTPAPI) Connect(ctx context.Context, moveID, token, fingerprint string, start bool) (*client.ConnectReply, error) {
	var r client.ConnectReply
	err := h.do(ctx, "/v1/moves/"+url.PathEscape(moveID)+"/connect", token,
		map[string]any{"clientDtlsFingerprint": fingerprint, "start": start}, &r)
	if err != nil {
		return nil, err
	}

	return &r, nil
}

// Report sends counts. A 409 invalid_state means the move changed while it was recorded: send it again.
func (h *HTTPAPI) Report(ctx context.Context, moveID, token string, r PlatformReport) error {
	err := h.do(ctx, "/v1/moves/"+url.PathEscape(moveID)+"/report", token, r, nil)
	var e *APIError
	if errors.As(err, &e) && e.Status == http.StatusConflict && e.Code == "invalid_state" {
		err = h.do(ctx, "/v1/moves/"+url.PathEscape(moveID)+"/report", token, r, nil)
	}

	return err
}

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// NormalizeCode reads a move code as a member types it: any case, with or without dashes or spaces,
// O for 0 and I or L for 1, as Crockford base32 allows. It returns XXXX-XXXX-XXXX.
func NormalizeCode(s string) (string, error) {
	var b strings.Builder
	for _, r := range strings.ToUpper(s) {
		switch {
		case r == '-' || r == ' ' || r == '\t' || r == '\r' || r == '\n':
			continue
		case r == 'O':
			r = '0'
		case r == 'I' || r == 'L':
			r = '1'
		}
		if !strings.ContainsRune(crockford, r) {
			return "", errors.New("that isn't a move code: it has a character a code never has")
		}
		b.WriteRune(r)
	}
	c := b.String()
	if len(c) != 12 {
		return "", fmt.Errorf("a move code has 12 characters, like ABCD-EFGH-JKMN; that had %d", len(c))
	}

	return c[0:4] + "-" + c[4:8] + "-" + c[8:12], nil
}
