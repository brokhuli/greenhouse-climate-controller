// Package reconcile is the platform's control-down engine (RFC-005): it owns each
// greenhouse's intended setpoint state and keeps the controller faithful to it. A crop-profile
// assignment or a sticky operator edit is resolved to a setpoint bundle, recorded in the
// append-only provenance ledger, and delivered to the controller's REST config API. A
// background loop then re-asserts intended state on reconnect and detects/corrects drift —
// staggered, idempotent, and rate-limited so it converges rather than storms (crop-profiles §3).
package reconcile

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"time"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/relay"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/state"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/store"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/ws"
)

// ErrUnknownGreenhouse is returned by Apply for a greenhouse that has no registered endpoint.
var ErrUnknownGreenhouse = errors.New("greenhouse not registered")

// Store is the persistence the reconciler reads and writes.
type Store interface {
	ListGreenhouses(ctx context.Context) ([]store.Greenhouse, error)
	GetEndpoint(ctx context.Context, id string) (store.Endpoint, bool, error)
	AppendRevision(ctx context.Context, revision domain.SetpointRevision) (int64, error)
	CurrentRevision(ctx context.Context, id string) (domain.SetpointRevision, bool, error)
	GetReconState(ctx context.Context, id string) (store.ReconState, bool, error)
	UpsertReconState(ctx context.Context, recon store.ReconState) error
	InsertEvent(ctx context.Context, event domain.Event) error
}

// Relayer issues controller REST calls (implemented by *relay.Client).
type Relayer interface {
	Do(ctx context.Context, method, baseURL, path string, token *string, body []byte) (relay.Response, error)
}

// FleetView reports a greenhouse's live connectivity (implemented by *state.Fleet).
type FleetView interface {
	Get(id string) (state.Live, bool)
}

// Broadcaster fans a frame out to connected SPA clients (implemented by *ws.Hub).
type Broadcaster interface {
	Broadcast(frame any)
}

// metricsRecorder counts reconciliation actions; *metrics.Metrics satisfies it. Kept as a
// narrow consumer-side interface so reconcile does not depend on the metrics package.
type metricsRecorder interface {
	ReconcileAction(action string)
}

// nopMetrics is the default when no recorder is injected (tests, unauthenticated 2a runs).
type nopMetrics struct{}

func (nopMetrics) ReconcileAction(string) {}

// Config tunes the reconciliation loop.
type Config struct {
	Interval   time.Duration // reconcile cycle cadence (P2-REL-1)
	Jitter     time.Duration // max random stagger between greenhouses within a cycle
	MaxRetries int           // consecutive failed deliveries/corrections before backing off
}

// Reconciler owns intended state and the control-down loop.
type Reconciler struct {
	store   Store
	relay   Relayer
	fleet   FleetView
	hub     Broadcaster
	metrics metricsRecorder
	log     *slog.Logger
	cfg     Config
	now     func() time.Time
}

// New builds a reconciler, applying defaults for a zero Config.
func New(store Store, relayer Relayer, fleet FleetView, hub Broadcaster, rec metricsRecorder, log *slog.Logger, cfg Config) *Reconciler {
	if cfg.Interval <= 0 {
		cfg.Interval = 30 * time.Second
	}
	if cfg.MaxRetries <= 0 {
		cfg.MaxRetries = 5
	}
	if rec == nil {
		rec = nopMetrics{}
	}
	return &Reconciler{
		store: store, relay: relayer, fleet: fleet, hub: hub, metrics: rec, log: log, cfg: cfg,
		now: func() time.Time { return time.Now().UTC() },
	}
}

// Resolve maps a crop profile's growth stage to its setpoint bundle — a direct field mapping,
// not a translation (crop-profiles §2). ok is false when the profile has no such stage.
func (r *Reconciler) Resolve(profile domain.CropProfile, stage string) (domain.Setpoints, bool) {
	resolved, ok := profile.Stage(stage)
	return resolved.Targets, ok
}

// ApplyOutcome reports how an intended-state change was delivered.
type ApplyOutcome struct {
	Revision         int64
	Setpoints        domain.Setpoints // the resulting intended bundle
	Delivered        bool             // reached and accepted by the controller
	Deferred         bool             // held because the controller is unreachable (re-asserted on reconnect)
	ControllerStatus int              // controller HTTP status when a delivery was attempted (0 otherwise)
	ControllerBody   []byte           // controller response body, for a 4xx passthrough
}

// Apply records a new intended state (a crop-profile resolution or a sticky operator/optimizer
// edit) and delivers it to the controller. When the controller is unreachable the intended
// state is still recorded and held for re-assert on reconnect; a controller validation refusal
// (4xx) is surfaced without recording, so an invalid edit never becomes intended state.
func (r *Reconciler) Apply(ctx context.Context, greenhouseID string, intended domain.Setpoints, source domain.SetpointSource, actor, reason string) (ApplyOutcome, error) {
	endpoint, found, err := r.store.GetEndpoint(ctx, greenhouseID)
	if err != nil {
		return ApplyOutcome{}, err
	}
	if !found {
		return ApplyOutcome{}, ErrUnknownGreenhouse
	}

	if !r.reachable(greenhouseID) {
		return r.record(ctx, greenhouseID, intended, source, actor, reason, store.DeliveryDeferred, 0, nil)
	}

	status, body, derr := r.deliver(ctx, greenhouseID, endpoint, intended)
	if derr != nil {
		// Transport failure — treat as unreachable: hold intended state, re-assert later.
		r.log.Warn("apply: controller unreachable, deferring", "id", greenhouseID, "err", derr)
		return r.record(ctx, greenhouseID, intended, source, actor, reason, store.DeliveryDeferred, 0, nil)
	}
	if !ok2xx(status) {
		// Controller refused (validation) — do not record as intended state.
		return ApplyOutcome{ControllerStatus: status, ControllerBody: body}, nil
	}
	return r.record(ctx, greenhouseID, intended, source, actor, reason, store.DeliveryDelivered, status, body)
}

// record appends the provenance revision, updates reconciliation bookkeeping, and emits the
// change-attribution event.
func (r *Reconciler) record(ctx context.Context, greenhouseID string, intended domain.Setpoints, source domain.SetpointSource, actor, reason, delivery string, status int, body []byte) (ApplyOutcome, error) {
	revision, err := r.store.AppendRevision(ctx, domain.SetpointRevision{
		GreenhouseID: greenhouseID, Source: source, Actor: actor, Reason: reason, Setpoints: intended,
	})
	if err != nil {
		return ApplyOutcome{}, err
	}
	recon, _, err := r.store.GetReconState(ctx, greenhouseID)
	if err != nil {
		return ApplyOutcome{}, err
	}
	recon.GreenhouseID = greenhouseID
	now := r.now()
	recon.LastAttemptAt = &now
	recon.DeliveryStatus = delivery
	recon.FailCount = 0
	wasDrift := recon.Drift
	if delivery == store.DeliveryDelivered {
		recon.LastDeliveredRevision = &revision
		recon.Drift = false
		recon.DriftFirstSeen = nil
	}
	if err := r.store.UpsertReconState(ctx, recon); err != nil {
		return ApplyOutcome{}, err
	}
	r.emitApplyEvent(ctx, greenhouseID, source, delivery)
	switch delivery {
	case store.DeliveryDelivered:
		r.metrics.ReconcileAction("apply")
	case store.DeliveryDeferred:
		r.metrics.ReconcileAction("deferred")
	}
	if wasDrift && delivery == store.DeliveryDelivered {
		r.broadcastDrift(greenhouseID, false)
	}
	return ApplyOutcome{
		Revision:         revision,
		Setpoints:        intended,
		Delivered:        delivery == store.DeliveryDelivered,
		Deferred:         delivery == store.DeliveryDeferred,
		ControllerStatus: status,
		ControllerBody:   body,
	}, nil
}

// Baseline returns the bundle a partial operator edit should merge onto: the current intended
// state if one exists, otherwise the controller's currently-reported setpoints (so the first
// edit bootstraps intended state from the controller's TOML defaults rather than from zero).
func (r *Reconciler) Baseline(ctx context.Context, greenhouseID string) (domain.Setpoints, error) {
	current, ok, err := r.store.CurrentRevision(ctx, greenhouseID)
	if err != nil {
		return domain.Setpoints{}, err
	}
	if ok {
		return current.Setpoints, nil
	}
	endpoint, found, err := r.store.GetEndpoint(ctx, greenhouseID)
	if err != nil {
		return domain.Setpoints{}, err
	}
	if !found {
		return domain.Setpoints{}, ErrUnknownGreenhouse
	}
	return r.reported(ctx, greenhouseID, endpoint)
}

// Start launches the background reconciliation loop; it stops when ctx is cancelled.
func (r *Reconciler) Start(ctx context.Context) {
	go r.loop(ctx)
}

func (r *Reconciler) loop(ctx context.Context) {
	ticker := time.NewTicker(r.cfg.Interval)
	defer ticker.Stop()
	r.ReconcileOnce(ctx) // re-assert promptly after a platform restart
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.ReconcileOnce(ctx)
		}
	}
}

// ReconcileOnce runs one reconciliation pass over the fleet: re-assert intended state that has
// not reached a controller (reconnect / changed-while-offline) and detect + rate-limited-correct
// drift. Greenhouses are staggered with jittered backoff so a shared reconnect does not thunder
// the controllers' REST APIs.
func (r *Reconciler) ReconcileOnce(ctx context.Context) {
	greenhouses, err := r.store.ListGreenhouses(ctx)
	if err != nil {
		r.log.Error("reconcile: list greenhouses", "err", err)
		return
	}
	for _, greenhouse := range greenhouses {
		if err := r.reconcileGreenhouse(ctx, greenhouse.ID); err != nil {
			r.log.Error("reconcile greenhouse", "id", greenhouse.ID, "err", err)
		}
		r.stagger(ctx)
	}
}

func (r *Reconciler) reconcileGreenhouse(ctx context.Context, greenhouseID string) error {
	current, hasCurrent, err := r.store.CurrentRevision(ctx, greenhouseID)
	if err != nil {
		return err
	}
	if !hasCurrent {
		return nil // no intended state yet — nothing to reconcile
	}
	recon, _, err := r.store.GetReconState(ctx, greenhouseID)
	if err != nil {
		return err
	}
	recon.GreenhouseID = greenhouseID
	endpoint, found, err := r.store.GetEndpoint(ctx, greenhouseID)
	if err != nil {
		return err
	}
	if !found {
		return nil
	}

	// Offline: hold intended state, marking it deferred once.
	if !r.reachable(greenhouseID) {
		if recon.DeliveryStatus != store.DeliveryDeferred {
			recon.DeliveryStatus = store.DeliveryDeferred
			return r.store.UpsertReconState(ctx, recon)
		}
		return nil
	}

	delivered := recon.LastDeliveredRevision != nil && *recon.LastDeliveredRevision == current.Revision
	if !delivered {
		// The current intended revision has not reached the controller — re-assert (reconnect / held).
		return r.reassert(ctx, greenhouseID, endpoint, current, &recon)
	}

	// Delivered: compare the controller's reported setpoints against intended to catch drift.
	reported, err := r.reported(ctx, greenhouseID, endpoint)
	if err != nil {
		r.log.Warn("reconcile: read controller setpoints", "id", greenhouseID, "err", err)
		return nil // cannot compare this cycle; retry next
	}
	if current.Setpoints.Reconciled(reported) {
		return r.markSynced(ctx, greenhouseID, &recon)
	}
	return r.handleDrift(ctx, greenhouseID, endpoint, current, &recon)
}

// reassert re-delivers the current intended revision, backing off after repeated failures.
func (r *Reconciler) reassert(ctx context.Context, greenhouseID string, endpoint store.Endpoint, current domain.SetpointRevision, recon *store.ReconState) error {
	if recon.FailCount >= r.cfg.MaxRetries {
		return nil // backed off; surfaced via delivery_status
	}
	status, _, err := r.deliver(ctx, greenhouseID, endpoint, current.Setpoints)
	now := r.now()
	recon.LastAttemptAt = &now
	if err != nil || !ok2xx(status) {
		recon.FailCount++
		recon.DeliveryStatus = store.DeliveryRejected
		r.log.Warn("reconcile: re-assert failed", "id", greenhouseID, "status", status, "err", err)
		return r.store.UpsertReconState(ctx, *recon)
	}
	recon.LastDeliveredRevision = &current.Revision
	recon.DeliveryStatus = store.DeliveryDelivered
	recon.FailCount = 0
	r.metrics.ReconcileAction("reassert")
	r.log.Info("reconcile: re-asserted intended state", "id", greenhouseID, "revision", current.Revision)
	return r.store.UpsertReconState(ctx, *recon)
}

// handleDrift flags out-of-band drift, surfaces it once, and attempts a rate-limited
// auto-correction; persistent drift is left surfaced rather than fought indefinitely.
func (r *Reconciler) handleDrift(ctx context.Context, greenhouseID string, endpoint store.Endpoint, current domain.SetpointRevision, recon *store.ReconState) error {
	now := r.now()
	newlyDrifted := !recon.Drift
	recon.Drift = true
	recon.DriftLastSeen = &now
	if recon.DriftFirstSeen == nil {
		recon.DriftFirstSeen = &now
	}
	if recon.FailCount < r.cfg.MaxRetries {
		status, _, err := r.deliver(ctx, greenhouseID, endpoint, current.Setpoints)
		recon.LastAttemptAt = &now
		recon.FailCount++ // count every correction attempt so persistent drift eventually backs off
		if err != nil || !ok2xx(status) {
			r.log.Warn("reconcile: drift correction failed", "id", greenhouseID, "status", status, "err", err)
		} else {
			r.metrics.ReconcileAction("drift_corrected")
			r.log.Info("reconcile: drift correction re-asserted", "id", greenhouseID, "revision", current.Revision)
		}
	}
	if err := r.store.UpsertReconState(ctx, *recon); err != nil {
		return err
	}
	if newlyDrifted {
		r.metrics.ReconcileAction("drift_detected")
		r.emitDriftEvent(ctx, greenhouseID)
		r.broadcastDrift(greenhouseID, true)
	}
	return nil
}

// markSynced clears deferred/drift bookkeeping once a greenhouse matches intended state again.
func (r *Reconciler) markSynced(ctx context.Context, greenhouseID string, recon *store.ReconState) error {
	changed := false
	if recon.DeliveryStatus != store.DeliveryDelivered {
		recon.DeliveryStatus = store.DeliveryDelivered
		changed = true
	}
	if recon.FailCount != 0 {
		recon.FailCount = 0
		changed = true
	}
	wasDrift := recon.Drift
	if recon.Drift {
		recon.Drift = false
		recon.DriftFirstSeen = nil
		changed = true
	}
	if !changed {
		return nil
	}
	if err := r.store.UpsertReconState(ctx, *recon); err != nil {
		return err
	}
	if wasDrift {
		r.broadcastDrift(greenhouseID, false)
	}
	return nil
}

// deliver pushes a resolved bundle to the controller: the global setpoints via PATCH /setpoints,
// then each zone's targets via PATCH /zones/{zone_id}. The first non-2xx status (global or zone)
// is returned so a controller refusal surfaces to the caller.
func (r *Reconciler) deliver(ctx context.Context, greenhouseID string, endpoint store.Endpoint, setpoints domain.Setpoints) (status int, body []byte, err error) {
	global, err := globalSetpointsBody(setpoints)
	if err != nil {
		return 0, nil, err
	}
	resp, err := r.relay.Do(ctx, http.MethodPatch, endpoint.RESTBaseURL, controllerSetpointsPath(greenhouseID), endpoint.BearerToken, global)
	if err != nil {
		return 0, nil, err
	}
	if !ok2xx(resp.Status) {
		return resp.Status, resp.Body, nil
	}
	for _, zone := range setpoints.Zones {
		zonePayload, err := zoneBody(zone)
		if err != nil {
			return 0, nil, err
		}
		zoneResp, err := r.relay.Do(ctx, http.MethodPatch, endpoint.RESTBaseURL, controllerZonePath(greenhouseID, zone.ZoneID), endpoint.BearerToken, zonePayload)
		if err != nil {
			return 0, nil, err
		}
		if !ok2xx(zoneResp.Status) {
			return zoneResp.Status, zoneResp.Body, nil
		}
	}
	return resp.Status, resp.Body, nil
}

// reported reads the controller's current setpoints (global + zones) for the drift comparison.
func (r *Reconciler) reported(ctx context.Context, greenhouseID string, endpoint store.Endpoint) (domain.Setpoints, error) {
	setpointsResp, err := r.relay.Do(ctx, http.MethodGet, endpoint.RESTBaseURL, controllerSetpointsPath(greenhouseID), endpoint.BearerToken, nil)
	if err != nil {
		return domain.Setpoints{}, err
	}
	if !ok2xx(setpointsResp.Status) {
		return domain.Setpoints{}, fmt.Errorf("controller setpoints status %d", setpointsResp.Status)
	}
	zonesResp, err := r.relay.Do(ctx, http.MethodGet, endpoint.RESTBaseURL, controllerZonesPath(greenhouseID), endpoint.BearerToken, nil)
	if err != nil {
		return domain.Setpoints{}, err
	}
	if !ok2xx(zonesResp.Status) {
		return domain.Setpoints{}, fmt.Errorf("controller zones status %d", zonesResp.Status)
	}
	return parseReported(setpointsResp.Body, zonesResp.Body)
}

func (r *Reconciler) reachable(greenhouseID string) bool {
	live, ok := r.fleet.Get(greenhouseID)
	if !ok {
		return false
	}
	return live.Status != domain.StatusOffline
}

func (r *Reconciler) stagger(ctx context.Context) {
	if r.cfg.Jitter <= 0 {
		return
	}
	select {
	case <-ctx.Done():
	case <-time.After(time.Duration(rand.Int64N(int64(r.cfg.Jitter)))):
	}
}

func (r *Reconciler) emitApplyEvent(ctx context.Context, greenhouseID string, source domain.SetpointSource, delivery string) {
	kind, message, actorSource := "setpoint_edit", "setpoint edit applied", "operator"
	switch source {
	case domain.SourceProfile:
		kind, message = "profile_applied", "crop profile applied"
	case domain.SourceOptimizer:
		message, actorSource = "optimizer setpoints applied", "optimizer"
	}
	if delivery == store.DeliveryDeferred {
		message += " (held until the controller reconnects)"
	}
	r.emitEvent(ctx, domain.Event{
		GreenhouseID: greenhouseID, TS: r.now(), Kind: kind, Severity: "info", Message: message, Source: actorSource,
	})
}

func (r *Reconciler) emitDriftEvent(ctx context.Context, greenhouseID string) {
	r.emitEvent(ctx, domain.Event{
		GreenhouseID: greenhouseID, TS: r.now(), Kind: "drift", Severity: "warning",
		Message: "controller setpoints drifted from intended state", Source: "platform",
	})
}

func (r *Reconciler) emitEvent(ctx context.Context, event domain.Event) {
	if err := r.store.InsertEvent(ctx, event); err != nil {
		r.log.Error("reconcile: audit event", "id", event.GreenhouseID, "kind", event.Kind, "err", err)
	}
	r.hub.Broadcast(ws.NewEvent(event))
}

func (r *Reconciler) broadcastDrift(greenhouseID string, drift bool) {
	r.hub.Broadcast(ws.NewDrift(greenhouseID, r.now(), drift))
}
