package link

import (
	"bytes"
	"context"
	"crypto/x509"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	onboard "agent-link"

	"github.com/jackc/pgx/v5"
)

//go:embed onboarding_schema.sql
var onboardingSchema string

// OnboardingPackage exists only in request memory. Package must not persist,
// log, publish, or execute its personal ServiceKey or the resulting archive.
type OnboardingPackage struct {
	AgentID, ProjectID                               string
	ChannelIDs                                       []string
	Runtime, ServiceKey, Origin, SPKIPin, Repository string
	CertificateCA                                    []byte
}

type OnboardingConfig struct {
	Origin, SPKIPin, Repository string
	CertificateCA, Installer    []byte
	Package                     func(context.Context, OnboardingPackage) ([]byte, error)
}

func (c *OnboardingConfig) Validate() error {
	if c == nil || c.Package == nil || len(c.Installer) == 0 || len(c.Installer) > 256<<10 || len(c.CertificateCA) > 128<<10 {
		return errors.New("onboarding assets are not configured")
	}
	origin, err := url.Parse(c.Origin)
	if err != nil || len(c.Origin) > 2048 || origin.Scheme != "https" || origin.Hostname() == "" || origin.User != nil || origin.RawQuery != "" || origin.Fragment != "" || origin.Path != "" || origin.Opaque != "" || origin.String() != c.Origin {
		return errors.New("onboarding requires an explicit HTTPS origin without path")
	}
	if port := origin.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return errors.New("invalid onboarding origin port")
		}
	}
	repository, err := url.Parse(c.Repository)
	if err != nil || repository.Scheme != "https" || repository.Hostname() == "" || repository.User != nil || repository.RawQuery != "" || repository.Fragment != "" || len(c.Repository) > 2048 {
		return errors.New("onboarding requires a trusted HTTPS repository")
	}
	pin, err := base64.StdEncoding.Strict().DecodeString(strings.TrimPrefix(c.SPKIPin, "sha256//"))
	if !strings.HasPrefix(c.SPKIPin, "sha256//") || err != nil || len(pin) != 32 {
		return errors.New("invalid onboarding SPKI pin")
	}
	certificates := bytes.TrimSpace(c.CertificateCA)
	if len(certificates) == 0 {
		return errors.New("invalid onboarding CA certificate")
	}
	for len(certificates) > 0 {
		if !bytes.HasPrefix(certificates, []byte("-----BEGIN CERTIFICATE-----")) {
			return errors.New("onboarding CA file must contain certificates only")
		}
		block, remaining := pem.Decode(certificates)
		if block == nil || block.Type != "CERTIFICATE" || len(block.Headers) != 0 {
			return errors.New("invalid onboarding CA certificate")
		}
		if _, err := x509.ParseCertificate(block.Bytes); err != nil {
			return errors.New("invalid onboarding CA certificate")
		}
		certificates = bytes.TrimSpace(remaining)
	}
	return nil
}

type onboardingInvitation struct {
	ID         string     `json:"id"`
	AgentID    string     `json:"agent_id"`
	AgentName  string     `json:"agent_name"`
	ProjectID  string     `json:"project_id"`
	ChannelIDs []string   `json:"channel_ids"`
	Runtime    string     `json:"runtime"`
	CreatedAt  time.Time  `json:"created_at"`
	ExpiresAt  time.Time  `json:"expires_at"`
	ClaimedAt  *time.Time `json:"claimed_at"`
	RevokedAt  *time.Time `json:"revoked_at"`
	Status     string     `json:"status"`
}

const invitationSelect = `SELECT i.id,i.agent_id,p.name,i.project_id,i.channel_ids,i.runtime,i.created_at,i.expires_at,i.claimed_at,i.revoked_at,
 CASE WHEN i.claimed_at IS NOT NULL THEN 'claimed' WHEN i.revoked_at IS NOT NULL THEN 'revoked' WHEN i.expires_at<=clock_timestamp() THEN 'expired' ELSE 'pending' END
 FROM onboarding_invitations i JOIN principals p ON p.id=i.agent_id `

func scanInvitation(row pgx.Row) (onboardingInvitation, error) {
	var i onboardingInvitation
	err := row.Scan(&i.ID, &i.AgentID, &i.AgentName, &i.ProjectID, &i.ChannelIDs, &i.Runtime, &i.CreatedAt, &i.ExpiresAt, &i.ClaimedAt, &i.RevokedAt, &i.Status)
	return i, err
}

func (s *Server) onboardingMetadata() map[string]any {
	result := map[string]any{"enabled": false, "public_url": "", "spki_pin": "", "repository": ""}
	// Static guidance is useful before invitations are configured. It carries no
	// scope or credentials and is shared with the redeemed package's exact bytes.
	if guidance, err := onboard.Guidance(); err == nil {
		result["guidance"] = guidance
	}
	if s.Onboarding != nil && s.Onboarding.Validate() == nil {
		result["enabled"], result["public_url"] = true, s.Onboarding.Origin
		result["spki_pin"], result["repository"] = s.Onboarding.SPKIPin, s.Onboarding.Repository
	}
	return result
}

func (s *Server) requireOnboarding(w http.ResponseWriter) bool {
	if s.Onboarding == nil || s.Onboarding.Validate() != nil {
		fail(w, http.StatusServiceUnavailable, "onboarding is not configured")
		return false
	}
	return true
}

func (s *Server) onboardingRoutes(api, public *http.ServeMux) {
	api.HandleFunc("GET /v1/admin/onboarding", s.adminOnboarding)
	api.HandleFunc("POST /v1/admin/onboarding", s.adminCreateOnboarding)
	api.HandleFunc("POST /v1/admin/onboarding/{invite}/revoke", s.adminRevokeOnboarding)
	api.HandleFunc("POST /v1/admin/onboarding/{invite}/reissue", s.adminReissueOnboarding)
	public.HandleFunc("GET /connect/install.sh", s.onboardingInstaller)
	public.HandleFunc("POST /connect/redeem", s.redeemOnboarding)
}

func (s *Server) adminOnboarding(w http.ResponseWriter, r *http.Request) {
	limit, ok := adminLimit(w, r)
	if !ok {
		return
	}
	tx, ok := s.adminTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	items, err := collect(r.Context(), tx, invitationSelect+"ORDER BY i.created_at DESC,i.id DESC LIMIT $1", func(row pgx.CollectableRow) (onboardingInvitation, error) { return scanInvitation(row) }, limit+1)
	if err != nil || tx.Commit(r.Context()) != nil {
		internal(w)
		return
	}
	result := s.onboardingMetadata()
	result["truncated"] = len(items) > limit
	if len(items) > limit {
		items = items[:limit]
	}
	result["invitations"] = items
	respond(w, 200, result)
}

func validInvitationHours(hours int) bool { return hours == 1 || hours == 12 || hours == 24 }

func revokeAgentInvitations(ctx context.Context, tx pgx.Tx, agent string) error {
	_, err := tx.Exec(ctx, "UPDATE onboarding_invitations SET revoked_at=clock_timestamp() WHERE agent_id=$1 AND claimed_at IS NULL AND revoked_at IS NULL", agent)
	return err
}

func insertInvitation(ctx context.Context, tx pgx.Tx, agent, project string, channels []string, runtime, owner string, hours int) (onboardingInvitation, string, error) {
	id, err := randomHex(16)
	if err != nil {
		return onboardingInvitation{}, "", err
	}
	token, err := randomHex(32)
	if err != nil {
		return onboardingInvitation{}, "", err
	}
	_, err = tx.Exec(ctx, `INSERT INTO onboarding_invitations(id,agent_id,project_id,channel_ids,runtime,token_hash,created_by,expires_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+$8*interval '1 hour')`, id, agent, project, channels, runtime, digest(token), owner, hours)
	if err != nil {
		return onboardingInvitation{}, "", err
	}
	i, err := scanInvitation(tx.QueryRow(ctx, invitationSelect+"WHERE i.id=$1", id))
	return i, token, err
}

func (s *Server) invitationResponse(w http.ResponseWriter, i onboardingInvitation, token string) {
	result := s.onboardingMetadata()
	result["invitation"], result["token"] = i, token
	respond(w, 201, result)
}

func (s *Server) adminCreateOnboarding(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID         string   `json:"id"`
		Name       string   `json:"name"`
		ProjectID  string   `json:"project_id"`
		ChannelIDs []string `json:"channel_ids"`
		Runtime    string   `json:"runtime"`
		Hours      int      `json:"expires_in_hours"`
	}
	if !decodeMax(w, r, &in, 8192) {
		return
	}
	if !validID(in.ID) || !validText(in.Name, 200) || !validID(in.ProjectID) || len(in.ChannelIDs) < 1 || len(in.ChannelIDs) > 8 || !validInvitationHours(in.Hours) || (in.Runtime != "auto" && in.Runtime != "codex" && in.Runtime != "claude") {
		fail(w, 400, "invalid onboarding fields")
		return
	}
	sort.Strings(in.ChannelIDs)
	for j, channel := range in.ChannelIDs {
		if !validID(channel) || j > 0 && channel == in.ChannelIDs[j-1] {
			fail(w, 400, "invalid onboarding channels")
			return
		}
	}
	tx, ok := s.adminTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	if !s.requireOnboarding(w) || !activeAdminProject(w, r, tx, in.ProjectID) {
		return
	}
	var channels int
	if err := tx.QueryRow(r.Context(), "SELECT count(*) FROM channels WHERE project_id=$1 AND id=ANY($2::text[])", in.ProjectID, in.ChannelIDs).Scan(&channels); err != nil {
		internal(w)
		return
	}
	if channels != len(in.ChannelIDs) {
		fail(w, 404, "onboarding channel not found in project")
		return
	}
	if _, err := tx.Exec(r.Context(), "INSERT INTO principals(id,name,kind,runtime) VALUES($1,$2,'agent',$3)", in.ID, in.Name, in.Runtime); err != nil {
		adminError(w, err)
		return
	}
	if _, err := tx.Exec(r.Context(), "INSERT INTO project_members(project_id,agent_id,can_write) VALUES($1,$2,true)", in.ProjectID, in.ID); err != nil {
		internal(w)
		return
	}
	if _, err := tx.Exec(r.Context(), "INSERT INTO channel_members(channel_id,agent_id,can_write) SELECT unnest($1::text[]),$2,true", in.ChannelIDs, in.ID); err != nil {
		internal(w)
		return
	}
	i, token, err := insertInvitation(r.Context(), tx, in.ID, in.ProjectID, in.ChannelIDs, in.Runtime, principal(r).ID, in.Hours)
	if err != nil {
		internal(w)
		return
	}
	if adminCommit(w, r, tx, "onboarding.create", "invitation", i.ID, auditDetails{AgentID: in.ID, ProjectID: in.ProjectID}) {
		s.invitationResponse(w, i, token)
	}
}

func (s *Server) adminRevokeOnboarding(w http.ResponseWriter, r *http.Request) {
	var in struct{}
	if !decode(w, r, &in) {
		return
	}
	tx, ok := s.adminTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	i, err := scanInvitation(tx.QueryRow(r.Context(), invitationSelect+"WHERE i.id=$1 FOR UPDATE OF i", r.PathValue("invite")))
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "invitation not found")
		return
	}
	if err != nil {
		internal(w)
		return
	}
	if i.ClaimedAt != nil {
		fail(w, 409, "invitation already claimed; manage the agent key separately")
		return
	}
	if i.RevokedAt == nil {
		if err := tx.QueryRow(r.Context(), "UPDATE onboarding_invitations SET revoked_at=clock_timestamp() WHERE id=$1 RETURNING revoked_at", i.ID).Scan(&i.RevokedAt); err != nil {
			internal(w)
			return
		}
		if !adminCommit(w, r, tx, "onboarding.revoke", "invitation", i.ID, auditDetails{AgentID: i.AgentID, ProjectID: i.ProjectID}) {
			return
		}
	} else if tx.Commit(r.Context()) != nil {
		internal(w)
		return
	}
	i.Status = "revoked"
	respond(w, 200, map[string]any{"invitation": i})
}

// Call under the management lock. This checks the selected grant set without
// restoring removed grants or expanding access to other projects/channels.
func invitationScopeValid(ctx context.Context, tx pgx.Tx, i onboardingInvitation) (bool, error) {
	var valid bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM principals a JOIN project_members pm ON pm.agent_id=a.id AND pm.project_id=$2
 JOIN projects p ON p.id=pm.project_id WHERE a.id=$1 AND a.kind='agent' AND a.key_hash IS NULL AND pm.can_write AND p.archived_at IS NULL)
 AND (SELECT count(*) FROM channels c JOIN channel_members cm ON cm.channel_id=c.id AND cm.agent_id=$1
 WHERE c.project_id=$2 AND c.id=ANY($3::text[]) AND cm.can_write)=$4`, i.AgentID, i.ProjectID, i.ChannelIDs, len(i.ChannelIDs)).Scan(&valid)
	return valid, err
}

func (s *Server) adminReissueOnboarding(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Hours int `json:"expires_in_hours"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !validInvitationHours(in.Hours) {
		fail(w, 400, "invalid invitation lifetime")
		return
	}
	tx, ok := s.adminTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	if !s.requireOnboarding(w) {
		return
	}
	old, err := scanInvitation(tx.QueryRow(r.Context(), invitationSelect+"WHERE i.id=$1 FOR UPDATE OF i", r.PathValue("invite")))
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "invitation not found")
		return
	}
	if err != nil {
		internal(w)
		return
	}
	valid, err := invitationScopeValid(r.Context(), tx, old)
	if err != nil {
		internal(w)
		return
	}
	if !valid {
		fail(w, 409, "agent must be inactive with the intended active write grants")
		return
	}
	if err := revokeAgentInvitations(r.Context(), tx, old.AgentID); err != nil {
		internal(w)
		return
	}
	i, token, err := insertInvitation(r.Context(), tx, old.AgentID, old.ProjectID, old.ChannelIDs, old.Runtime, principal(r).ID, in.Hours)
	if err != nil {
		internal(w)
		return
	}
	if adminCommit(w, r, tx, "onboarding.reissue", "invitation", i.ID, auditDetails{AgentID: i.AgentID, ProjectID: i.ProjectID}) {
		s.invitationResponse(w, i, token)
	}
}

func (s *Server) onboardingInstaller(w http.ResponseWriter, r *http.Request) {
	if !s.requireOnboarding(w) {
		return
	}
	if r.URL.RawQuery != "" {
		fail(w, 400, "query parameters are not accepted")
		return
	}
	w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(s.Onboarding.Installer)))
	_, _ = w.Write(s.Onboarding.Installer)
}

func (s *Server) redeemOnboarding(w http.ResponseWriter, r *http.Request) {
	if !s.requireOnboarding(w) {
		return
	}
	if r.URL.RawQuery != "" {
		fail(w, 400, "query parameters are not accepted")
		return
	}
	var in struct {
		Token string `json:"token"`
	}
	if !decodeMax(w, r, &in, 1024) {
		return
	}
	decoded, err := hex.DecodeString(in.Token)
	if err != nil || len(decoded) != 32 || strings.ToLower(in.Token) != in.Token {
		fail(w, 400, "invalid invitation token")
		return
	}
	select {
	case s.onboardingGate <- struct{}{}:
		defer func() { <-s.onboardingGate }()
	default:
		fail(w, 429, "onboarding redemption busy")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		internal(w)
		return
	}
	defer tx.Rollback(ctx)
	if err := managementLock(ctx, tx, false); err != nil {
		internal(w)
		return
	}
	i, err := scanInvitation(tx.QueryRow(ctx, invitationSelect+"WHERE i.token_hash=$1 AND i.claimed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>clock_timestamp() FOR UPDATE OF i", digest(in.Token)))
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 410, "invitation unavailable")
		return
	}
	if err != nil {
		internal(w)
		return
	}
	valid, err := invitationScopeValid(ctx, tx, i)
	if err != nil {
		internal(w)
		return
	}
	if !valid {
		fail(w, 410, "invitation unavailable")
		return
	}
	key, err := randomHex(32)
	if err != nil {
		internal(w)
		return
	}
	body, err := s.Onboarding.Package(ctx, OnboardingPackage{AgentID: i.AgentID, ProjectID: i.ProjectID, ChannelIDs: i.ChannelIDs,
		Runtime: i.Runtime, ServiceKey: key, Origin: s.Onboarding.Origin, SPKIPin: s.Onboarding.SPKIPin, Repository: s.Onboarding.Repository, CertificateCA: s.Onboarding.CertificateCA})
	if err != nil || len(body) == 0 || len(body) > 16<<20 {
		fail(w, 503, "onboarding package unavailable; invitation remains unclaimed")
		return
	}
	claimed, err := tx.Exec(ctx, "UPDATE onboarding_invitations SET claimed_at=clock_timestamp() WHERE id=$1 AND expires_at>clock_timestamp()", i.ID)
	if err != nil {
		internal(w)
		return
	}
	if claimed.RowsAffected() != 1 {
		fail(w, 410, "invitation unavailable")
		return
	}
	if _, err := tx.Exec(ctx, "UPDATE principals SET key_hash=$1 WHERE id=$2", digest(key), i.AgentID); err != nil {
		internal(w)
		return
	}
	if err := writeAudit(ctx, tx, i.AgentID, "onboarding.claim", "invitation", i.ID, auditDetails{AgentID: i.AgentID, ProjectID: i.ProjectID}); err != nil {
		internal(w)
		return
	}
	if tx.Commit(ctx) != nil {
		internal(w)
		return
	}
	// A lost response cannot be replayed: the server retains hashes only. Recovery
	// requires an explicit owner key revocation and a newly issued invitation.
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(10 * time.Second))
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", "attachment; filename=agent-onboarding.tar.gz")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	_, _ = w.Write(body)
}
