package link

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

type projectMapProject struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	ArchivedAt *time.Time `json:"archived_at"`
}

type projectMapNode struct {
	Key   string         `json:"key"`
	Type  string         `json:"type"`
	ID    string         `json:"id"`
	Label string         `json:"label"`
	Meta  map[string]any `json:"meta"`
}

type projectMapEdge struct {
	Source string `json:"source"`
	Target string `json:"target"`
	Kind   string `json:"kind"`
	Label  string `json:"label"`
}

type projectMapGroup struct {
	Type      string `json:"type"`
	Total     int64  `json:"total"`
	Shown     int    `json:"shown"`
	Truncated bool   `json:"truncated"`
}

func projectMapKey(parts ...string) string {
	encoded, _ := json.Marshal(parts)
	return base64.RawURLEncoding.EncodeToString(encoded)
}

// Only allowlisted metadata is selected. Raw bodies, payloads, activity text,
// hashes, credentials and verification commands never enter the response.
// One bounded query per entity kind replaces per-message/task/version requests.
const projectMapVisible = `WITH visible_channels AS MATERIALIZED (
 SELECT c.id FROM channels c WHERE c.project_id=$1 AND ($3::boolean OR EXISTS (
 SELECT 1 FROM channel_members cm JOIN project_members pm ON pm.agent_id=cm.agent_id
 JOIN projects p ON p.id=pm.project_id
 WHERE cm.channel_id=c.id AND cm.agent_id=$2 AND pm.project_id=c.project_id AND p.archived_at IS NULL)))`

type projectMapQuery struct{ kind, sql string }

// Artifact references are explicit published IDs, not a hash/base-revision join.
// Scope-filter even these references before putting their IDs in metadata.
func projectMapArtifactIDs(expression string) string {
	return `COALESCE((SELECT jsonb_agg(a.id ORDER BY a.id) FROM jsonb_array_elements(
 CASE WHEN jsonb_typeof(` + expression + `)='array' THEN ` + expression + ` ELSE '[]'::jsonb END) ref
 JOIN link_artifacts a ON a.id=ref->>'artifact_id' WHERE a.project_id=$1),'[]'::jsonb)`
}

func projectMapQueries() []projectMapQuery {
	return []projectMapQuery{
		{"agent", `SELECT a.id,a.name AS label,jsonb_build_object('project_id',$1::text,'agent_id',a.id,'kind',a.kind) AS meta,
 'epoch'::timestamptz AS sort_time,a.id AS sort_id FROM principals a JOIN project_members pm ON pm.agent_id=a.id
 WHERE pm.project_id=$1 AND ($3::boolean OR EXISTS(SELECT 1 FROM channel_members cm JOIN visible_channels vc ON vc.id=cm.channel_id WHERE cm.agent_id=a.id))`},
		{"channel", `SELECT c.id,c.name AS label,jsonb_build_object('project_id',c.project_id,'channel_id',c.id) AS meta,
 'epoch'::timestamptz AS sort_time,c.id AS sort_id FROM channels c JOIN visible_channels vc ON vc.id=c.id`},
		{"message", `SELECT m.id,'Message '||m.id AS label,jsonb_build_object('project_id',$1::text,'channel_id',m.channel_id,
 'author_id',m.author_id,'recipient_ids',m.recipient_ids,'reply_to',CASE WHEN EXISTS(SELECT 1 FROM messages parent JOIN visible_channels vc ON vc.id=parent.channel_id WHERE parent.id=m.reply_to) THEN m.reply_to END,
 'seq',m.seq,'created_at',m.created_at) AS meta,m.created_at AS sort_time,m.id AS sort_id
 FROM messages m JOIN visible_channels vc ON vc.id=m.channel_id`},
		{"receipt", `SELECT r.message_id AS id,'Delivery status · '||r.agent_id AS label,jsonb_build_object('project_id',$1::text,
 'channel_id',m.channel_id,'message_id',r.message_id,'agent_id',r.agent_id,'session_id',r.session_id,
 'delivered_at',r.delivered_at,'accepted_at',r.accepted_at,'uncertain_at',r.uncertain_at) AS meta,
 GREATEST(r.delivered_at,r.accepted_at,r.uncertain_at,m.created_at) AS sort_time,jsonb_build_array(r.message_id,r.agent_id)::text AS sort_id
 FROM receipts r JOIN messages m ON m.id=r.message_id JOIN visible_channels vc ON vc.id=m.channel_id`},
		{"native", `SELECT n.id,n.event_type AS label,jsonb_build_object('project_id',$1::text,'channel_id',n.channel_id,
 'actor_id',n.actor_id,'session_id',n.session_id,'type',n.event_type,'runtime',n.runtime,
 'message_id',CASE WHEN EXISTS(SELECT 1 FROM messages m JOIN visible_channels vc ON vc.id=m.channel_id WHERE m.id=n.message_id AND m.channel_id=n.channel_id) THEN n.message_id END,
 'created_at',n.created_at) AS meta,n.created_at AS sort_time,n.id AS sort_id
 FROM native_activity n JOIN visible_channels vc ON vc.id=n.channel_id`},
		{"session", `SELECT s.session_id AS id,'Session lease '||s.session_id AS label,jsonb_build_object('project_id',s.project_id,
 'channel_id',s.channel_id,'agent_id',s.agent_id,'session_id',s.session_id,'run_id',s.run_id,'role',s.task_role,
 'expires_at',s.expires_at,'closed_at',s.closed_at,'created_at',s.created_at) AS meta,s.created_at AS sort_time,
 jsonb_build_array(s.project_id,s.agent_id,s.session_id)::text AS sort_id FROM execution_sessions s JOIN visible_channels vc ON vc.id=s.channel_id WHERE s.project_id=$1`},
		{"task", `SELECT t.id,t.title AS label,jsonb_build_object('project_id',t.project_id,'task_id',t.id,'owner_id',t.owner_id,
 'reviewer_id',t.reviewer_id,'created_by',t.created_by,'current_run_id',t.current_run_id,'state',t.state,'version',t.version,
 'created_at',t.created_at,'updated_at',t.updated_at) AS meta,t.updated_at AS sort_time,t.id AS sort_id FROM link_tasks t WHERE t.project_id=$1`},
		{"run", `SELECT r.id,'Task run '||r.id AS label,jsonb_build_object('project_id',t.project_id,'task_id',r.task_id,'run_id',r.id,
 'state',r.state,'version',r.version,'review_request_id',(SELECT request.id FROM link_task_events request WHERE request.id=r.review_request_id AND request.task_id=r.task_id AND request.run_id=r.id AND request.type='review_requested'),'verification_status',r.verification_status,
 'artifact_ids',` + projectMapArtifactIDs("r.artifacts") + `,'created_at',r.created_at,'updated_at',r.updated_at) AS meta,
 r.updated_at AS sort_time,r.id AS sort_id FROM link_task_runs r JOIN link_tasks t ON t.id=r.task_id WHERE t.project_id=$1`},
		{"artifact", `SELECT a.id,'Artifact '||a.role||' · '||a.id AS label,jsonb_build_object('project_id',a.project_id,'author_id',a.author_id,
 'role',a.role,'size_bytes',a.size_bytes,'created_at',a.created_at) AS meta,a.created_at AS sort_time,a.id AS sort_id FROM link_artifacts a WHERE a.project_id=$1`},
		{"memory", `SELECT m.id,m.title AS label,jsonb_build_object('project_id',m.project_id,'memory_id',m.id,'author_id',m.author_id,
 'updated_by',m.updated_by,'version',m.version,'created_at',m.created_at,'updated_at',m.updated_at) AS meta,
 m.updated_at AS sort_time,m.id AS sort_id FROM link_memory m WHERE m.project_id=$1`},
		{"memory-version", `SELECT v.memory_id AS id,v.title AS label,jsonb_build_object('project_id',v.project_id,'memory_id',v.memory_id,
 'author_id',v.author_id,'version',v.version,'created_at',v.created_at) AS meta,v.created_at AS sort_time,
 jsonb_build_array(v.memory_id,v.version)::text AS sort_id FROM link_memory_versions v WHERE v.project_id=$1`},
		{"note", `SELECT n.id,n.title AS label,jsonb_build_object('project_id',n.project_id,'author_id',n.author_id,
 'source_message_id',CASE WHEN EXISTS(SELECT 1 FROM messages m JOIN visible_channels vc ON vc.id=m.channel_id WHERE m.id=n.source_message_id) THEN n.source_message_id END,
 'version',n.version,'created_at',n.created_at) AS meta,n.created_at AS sort_time,n.id AS sort_id FROM notes n WHERE n.project_id=$1`},
		{"task-event", `SELECT e.id,e.type AS label,jsonb_build_object('project_id',t.project_id,'task_id',e.task_id,'run_id',e.run_id,
 'actor_id',e.actor_id,'version',e.version,'type',e.type,'review_request_id',(SELECT request.id FROM link_task_events request WHERE request.id=e.payload->>'review_request_id' AND request.task_id=e.task_id AND request.run_id=e.run_id AND request.type='review_requested'),
 'verdict',CASE WHEN e.type='review_result' THEN e.payload->>'verdict' END,
 'artifact_ids',` + projectMapArtifactIDs("e.payload->'artifacts'") + `,
 'evidence_artifact_id',(SELECT a.id FROM link_artifacts a WHERE a.project_id=$1 AND a.role='evidence' AND a.id=e.payload->'evidence'->'artifact'->>'artifact_id'),
 'created_at',e.created_at) AS meta,e.created_at AS sort_time,e.id AS sort_id FROM link_task_events e JOIN link_tasks t ON t.id=e.task_id WHERE t.project_id=$1`},
	}
}

func (s *Server) projectMap(w http.ResponseWriter, r *http.Request) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		fail(w, 400, "invalid map query")
		return
	}
	limit := 25
	for key, values := range query {
		if key != "limit" || len(values) != 1 || values[0] == "" {
			fail(w, 400, "invalid map query")
			return
		}
		limit, err = strconv.Atoi(values[0])
		if err != nil || limit < 1 || limit > 50 {
			fail(w, 400, "invalid map limit")
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	reader, projectID := principal(r), r.PathValue("project")
	tx, err := s.Store.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		internal(w)
		return
	}
	defer tx.Rollback(ctx)
	var kind string
	err = tx.QueryRow(ctx, `SELECT kind FROM principals WHERE id=$1 AND key_hash=$2`, reader.ID, digest(bearer(r))).Scan(&kind)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 401, "invalid or revoked key")
		return
	}
	if err != nil {
		internal(w)
		return
	}
	if !projectAccess(ctx, tx, projectID, reader.ID, false) {
		fail(w, 404, "not found")
		return
	}
	var project projectMapProject
	var generated time.Time
	if tx.QueryRow(ctx, `SELECT id,name,archived_at,transaction_timestamp() FROM projects WHERE id=$1`, projectID).Scan(&project.ID, &project.Name, &project.ArchivedAt, &generated) != nil {
		internal(w)
		return
	}
	nodes := []projectMapNode{{Key: projectMapKey("project", project.ID), Type: "project", ID: project.ID, Label: project.Name,
		Meta: map[string]any{"project_id": project.ID, "archived_at": project.ArchivedAt}}}
	groups := []projectMapGroup{{Type: "project", Total: 1, Shown: 1}}
	for _, definition := range projectMapQueries() {
		groupNodes, total, err := loadProjectMapGroup(ctx, tx, definition, projectID, reader.ID, kind == "owner", limit)
		if err != nil {
			internal(w)
			return
		}
		nodes = append(nodes, groupNodes...)
		groups = append(groups, projectMapGroup{Type: definition.kind, Total: total, Shown: len(groupNodes), Truncated: int64(len(groupNodes)) < total})
	}
	edges, err := projectMapEdges(ctx, tx, projectID, nodes)
	if err != nil {
		internal(w)
		return
	}
	respond(w, 200, map[string]any{"project": project, "generated_at": generated, "nodes": nodes, "edges": edges, "groups": groups, "read_only": true})
}

func loadProjectMapGroup(ctx context.Context, tx pgx.Tx, definition projectMapQuery, projectID, readerID string, owner bool, limit int) ([]projectMapNode, int64, error) {
	rows, err := tx.Query(ctx, projectMapVisible+`, eligible AS (`+definition.sql+`)
 SELECT id,label,meta,count(*) OVER() FROM eligible ORDER BY sort_time DESC,sort_id DESC LIMIT $4`, projectID, readerID, owner, limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	nodes := []projectMapNode{}
	var total int64
	for rows.Next() {
		item := projectMapNode{Type: definition.kind}
		var raw []byte
		if err := rows.Scan(&item.ID, &item.Label, &raw, &total); err != nil {
			return nil, 0, err
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		if err := decoder.Decode(&item.Meta); err != nil {
			return nil, 0, err
		}
		text := func(field string) string { value, _ := item.Meta[field].(string); return value }
		switch item.Type {
		case "receipt":
			item.ID = projectMapKey(text("message_id"), text("agent_id"))
		case "session":
			item.ID = projectMapKey(projectID, text("agent_id"), text("session_id"))
		case "memory-version":
			version, _ := item.Meta["version"].(json.Number)
			item.ID = projectMapKey(text("memory_id"), version.String())
		}
		item.Key = projectMapKey(item.Type, item.ID)
		nodes = append(nodes, item)
	}
	return nodes, total, rows.Err()
}

func projectMapEdges(ctx context.Context, tx pgx.Tx, projectID string, nodes []projectMapNode) ([]projectMapEdge, error) {
	byKey := make(map[string]projectMapNode, len(nodes))
	var agentIDs, channelIDs []string
	for _, node := range nodes {
		byKey[node.Key] = node
		if node.Type == "agent" {
			agentIDs = append(agentIDs, node.ID)
		}
		if node.Type == "channel" {
			channelIDs = append(channelIDs, node.ID)
		}
	}
	edges := []projectMapEdge{}
	seen := map[string]bool{}
	add := func(source, target, kind, label string) {
		if _, ok := byKey[source]; !ok {
			return
		}
		if _, ok := byKey[target]; !ok {
			return
		}
		identity := projectMapKey(source, target, kind)
		if !seen[identity] {
			seen[identity] = true
			edges = append(edges, projectMapEdge{Source: source, Target: target, Kind: kind, Label: label})
		}
	}
	projectKey := projectMapKey("project", projectID)
	for _, node := range nodes {
		text := func(field string) string { value, _ := node.Meta[field].(string); return value }
		from := func(kind, id, relation, label string) {
			if id != "" {
				add(projectMapKey(kind, id), node.Key, relation, label)
			}
		}
		to := func(kind, id, relation, label string) {
			if id != "" {
				add(node.Key, projectMapKey(kind, id), relation, label)
			}
		}
		switch node.Type {
		case "agent":
			add(projectKey, node.Key, "project_member", "Project member")
		case "channel", "task", "artifact", "memory", "memory-version", "note", "session":
			add(projectKey, node.Key, "project_contains", "In project")
		}
		switch node.Type {
		case "message", "native", "session":
			from("channel", text("channel_id"), "channel_contains", "In channel")
		}
		switch node.Type {
		case "message":
			from("agent", text("author_id"), "authored", "Message author")
			to("message", text("reply_to"), "reply_to", "Reply to message")
			if ids, ok := node.Meta["recipient_ids"].([]any); ok {
				for _, value := range ids {
					if id, ok := value.(string); ok {
						to("agent", id, "recipient", "Recipient")
					}
				}
			}
		case "receipt":
			from("message", text("message_id"), "receipt_for", "Recipient delivery status")
			from("agent", text("agent_id"), "receipt_actor", "Message recipient")
		case "native":
			from("agent", text("actor_id"), "reported", "CLI report author")
			to("message", text("message_id"), "reported_message", "Message report")
		case "session":
			from("agent", text("agent_id"), "session_actor", "Lease account")
			// run_id/session_id are caller correlations, not TaskRun/CLI foreign keys.
		case "task":
			from("agent", text("owner_id"), "task_owner", "Assigned task owner")
			from("agent", text("reviewer_id"), "task_reviewer", "Assigned reviewer")
			from("agent", text("created_by"), "created", "Task creator")
			to("run", text("current_run_id"), "current_run", "Current task run")
		case "run":
			from("task", text("task_id"), "task_run", "Task run")
			to("task-event", text("review_request_id"), "review_request", "Run review request")
		case "artifact", "memory", "memory-version", "note":
			from("agent", text("author_id"), "authored", "Publication author")
			if node.Type == "memory" {
				from("agent", text("updated_by"), "updated", "Current version author")
			}
			if node.Type == "memory-version" {
				from("memory", text("memory_id"), "memory_version", "Memory version")
			}
			if node.Type == "note" {
				to("message", text("source_message_id"), "source_message", "Note source")
			}
		case "task-event":
			from("task", text("task_id"), "task_event", "Task event")
			from("run", text("run_id"), "run_event", "Run event")
			from("agent", text("actor_id"), "reported", "Task event author")
			to("task-event", text("review_request_id"), "review_request", "Review request response")
			to("artifact", text("evidence_artifact_id"), "evidence_ref", "External report artifact")
		}
		if node.Type == "run" || node.Type == "task-event" {
			if ids, ok := node.Meta["artifact_ids"].([]any); ok {
				for _, value := range ids {
					if id, ok := value.(string); ok {
						to("artifact", id, "artifact_ref", "Published artifact reference")
					}
				}
			}
		}
	}
	if len(agentIDs) > 0 && len(channelIDs) > 0 {
		rows, err := tx.Query(ctx, `SELECT cm.agent_id,cm.channel_id FROM channel_members cm
 JOIN channels c ON c.id=cm.channel_id JOIN project_members pm ON pm.agent_id=cm.agent_id AND pm.project_id=c.project_id
 WHERE c.project_id=$1 AND cm.agent_id=ANY($2::text[]) AND cm.channel_id=ANY($3::text[]) ORDER BY cm.agent_id,cm.channel_id`, projectID, agentIDs, channelIDs)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var agent, channel string
			if err := rows.Scan(&agent, &channel); err != nil {
				return nil, err
			}
			add(projectMapKey("agent", agent), projectMapKey("channel", channel), "channel_member", "Channel member")
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	return edges, nil
}
