package move

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// API bases.
const (
	ProdAPI    = "https://api.minimalistalliance.com"
	StagingAPI = "https://api.staging.minimalistalliance.com"
)

// LocalDesk is what a self-hosted desk records about itself once it's paired (task 31,
// /data/selfhost/desk.json). Of /data/selfhost, ma-move reads this file, and the desk's key (`key.pem`, sign.go) to sign the claim; it never sends, prints or logs the key.
type LocalDesk struct {
	DeskID string `json:"deskId"`
	Env    string `json:"env"`
}

var errNotADesk = &Refusal{Check: "not_a_desk", Message: "This computer isn't a desk in an office yet: run the install first " +
	"(sudo ./selfhost/install.sh), add it to your office, then run sudo ma-move again. Nothing was changed."}

// ReadLocalDesk reads <dataRoot>/selfhost/desk.json.
func ReadLocalDesk(dataRoot string) (LocalDesk, error) {
	f, err := os.OpenFile(filepath.Join(dataRoot, "selfhost", "desk.json"), os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if errors.Is(err, fs.ErrNotExist) {
		return LocalDesk{}, errNotADesk
	}
	if err != nil {
		return LocalDesk{}, fmt.Errorf("reading this desk's ID: %w", err)
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 64*1024))
	if err != nil {
		return LocalDesk{}, err
	}
	var d LocalDesk
	if json.Unmarshal(b, &d) != nil || !strings.HasPrefix(d.DeskID, "d-") || len(d.DeskID) > 64 {
		return LocalDesk{}, errNotADesk
	}

	return d, nil
}

// ResolveTarget is this desk's ID: the one the self-hosted desk records. --target-desk may only repeat it.
func ResolveTarget(dataRoot, flag string) (LocalDesk, error) {
	d, err := ReadLocalDesk(dataRoot)
	if err != nil {
		return LocalDesk{}, err
	}
	if flag != "" && flag != d.DeskID {
		return LocalDesk{}, &Refusal{Check: "not_a_desk", Message: fmt.Sprintf("This computer is the desk %s, not %s. "+
			"Leave out --target-desk, or run it on that desk. Nothing was changed.", d.DeskID, flag)}
	}

	return d, nil
}

// APIBase picks the API: --api if given, else --staging, else the env the desk was paired in.
func APIBase(explicit string, staging bool, env string) string {
	switch {
	case explicit != "":
		return explicit
	case staging || env == "staging":
		return StagingAPI
	default:
		return ProdAPI
	}
}
