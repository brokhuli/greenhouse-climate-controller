package reconcile

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/relay"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/state"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/store"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/ws"
)

// --- fakes ---

type fakeStore struct {
	greenhouses []store.Greenhouse
	endpoints   map[string]store.Endpoint
	revisions   map[string][]domain.SetpointRevision
	recon       map[string]store.ReconState
	events      []domain.Event
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		endpoints: map[string]store.Endpoint{},
		revisions: map[string][]domain.SetpointRevision{},
		recon:     map[string]store.ReconState{},
	}
}

func (f *fakeStore) ListGreenhouses(context.Context) ([]store.Greenhouse, error) {
	return f.greenhouses, nil
}
func (f *fakeStore) GetEndpoint(_ context.Context, id string) (store.Endpoint, bool, error) {
	endpoint, ok := f.endpoints[id]
	return endpoint, ok, nil
}
func (f *fakeStore) AppendRevision(_ context.Context, revision domain.SetpointRevision) (int64, error) {
	list := f.revisions[revision.GreenhouseID]
	revision.Revision = int64(len(list) + 1)
	f.revisions[revision.GreenhouseID] = append(list, revision)
	return revision.Revision, nil
}
func (f *fakeStore) CurrentRevision(_ context.Context, id string) (domain.SetpointRevision, bool, error) {
	list := f.revisions[id]
	if len(list) == 0 {
		return domain.SetpointRevision{}, false, nil
	}
	return list[len(list)-1], true, nil
}
func (f *fakeStore) GetReconState(_ context.Context, id string) (store.ReconState, bool, error) {
	recon, ok := f.recon[id]
	return recon, ok, nil
}
func (f *fakeStore) UpsertReconState(_ context.Context, recon store.ReconState) error {
	f.recon[recon.GreenhouseID] = recon
	return nil
}
func (f *fakeStore) InsertEvent(_ context.Context, event domain.Event) error {
	f.events = append(f.events, event)
	return nil
}
func (f *fakeStore) eventKinds() []string {
	kinds := make([]string, len(f.events))
	for i, event := range f.events {
		kinds[i] = event.Kind
	}
	return kinds
}

type relayCall struct {
	method string
	path   string
}

type fakeRelay struct {
	mu        sync.Mutex
	calls     []relayCall
	responder func(method, path string) (relay.Response, error)
}

func (f *fakeRelay) Do(_ context.Context, method, _, path string, _ *string, _ []byte) (relay.Response, error) {
	f.mu.Lock()
	f.calls = append(f.calls, relayCall{method, path})
	f.mu.Unlock()
	if f.responder == nil {
		return relay.Response{Status: http.StatusOK, Body: []byte("{}")}, nil
	}
	return f.responder(method, path)
}

func (f *fakeRelay) patchCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	count := 0
	for _, call := range f.calls {
		if call.method == http.MethodPatch {
			count++
		}
	}
	return count
}

type fakeFleet struct {
	status map[string]domain.Connectivity
}

func (f fakeFleet) Get(id string) (state.Live, bool) {
	status, ok := f.status[id]
	if !ok {
		return state.Live{}, false
	}
	return state.Live{Status: status}, true
}

type fakeHub struct {
	mu     sync.Mutex
	frames []any
}

func (f *fakeHub) Broadcast(frame any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.frames = append(f.frames, frame)
}
func (f *fakeHub) driftFrames() []ws.DriftFrame {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []ws.DriftFrame
	for _, frame := range f.frames {
		if drift, ok := frame.(ws.DriftFrame); ok {
			out = append(out, drift)
		}
	}
	return out
}
func (f *fakeHub) eventFrames() []ws.EventFrame {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []ws.EventFrame
	for _, frame := range f.frames {
		if event, ok := frame.(ws.EventFrame); ok {
			out = append(out, event)
		}
	}
	return out
}

// --- helpers ---

func newTestReconciler(fs *fakeStore, fr *fakeRelay, ff fakeFleet, fh *fakeHub) *Reconciler {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return New(fs, fr, ff, fh, nil, log, Config{Interval: time.Hour, Jitter: 0, MaxRetries: 3})
}

func onlineFleet(id string) fakeFleet {
	return fakeFleet{status: map[string]domain.Connectivity{id: domain.StatusOnline}}
}

// okController answers a controller that reports `reported` and accepts every PATCH.
func okController(greenhouseID string, reported domain.Setpoints) func(method, path string) (relay.Response, error) {
	global, _ := globalSetpointsBody(reported)
	zones, _ := json.Marshal(reported.Zones)
	return func(method, path string) (relay.Response, error) {
		switch {
		case method == http.MethodGet && path == controllerSetpointsPath(greenhouseID):
			return relay.Response{Status: http.StatusOK, Body: global}, nil
		case method == http.MethodGet && path == controllerZonesPath(greenhouseID):
			return relay.Response{Status: http.StatusOK, Body: zones}, nil
		default:
			return relay.Response{Status: http.StatusOK, Body: global}, nil
		}
	}
}

// --- Resolve ---

func TestResolveMapsStageTargets(t *testing.T) {
	r := &Reconciler{}
	profile := domain.CropProfile{Stages: []domain.ProfileStage{{Stage: "vegetative", Targets: domain.Setpoints{TemperatureDayC: 22}}}}
	resolved, ok := r.Resolve(profile, "vegetative")
	if !ok || resolved.TemperatureDayC != 22 {
		t.Fatalf("resolve=%v ok=%v", resolved, ok)
	}
	if _, ok := r.Resolve(profile, "fruiting"); ok {
		t.Fatal("unknown stage should not resolve")
	}
}

// --- Apply ---

func TestApplyDeliversWhenOnline(t *testing.T) {
	fs := newFakeStore()
	fs.endpoints["gh-a"] = store.Endpoint{RESTBaseURL: "http://gh-a"}
	setpoints := domain.Setpoints{TemperatureDayC: 24, Zones: []domain.ZoneTargets{{ZoneID: "z1"}}}
	fr := &fakeRelay{responder: okController("gh-a", setpoints)}
	fh := &fakeHub{}
	r := newTestReconciler(fs, fr, onlineFleet("gh-a"), fh)

	outcome, err := r.Apply(context.Background(), "gh-a", setpoints, domain.SourceProfile, "operator", "assign lettuce")
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if !outcome.Delivered || outcome.Revision != 1 {
		t.Fatalf("outcome=%+v want delivered rev1", outcome)
	}
	recon := fs.recon["gh-a"]
	if recon.DeliveryStatus != store.DeliveryDelivered || recon.LastDeliveredRevision == nil || *recon.LastDeliveredRevision != 1 {
		t.Fatalf("recon=%+v", recon)
	}
	if fr.patchCount() != 2 { // global setpoints + one zone
		t.Fatalf("want 2 PATCH calls, got %d", fr.patchCount())
	}
	events := fh.eventFrames()
	if len(events) != 1 || events[0].Kind != "profile_applied" {
		t.Fatalf("event frames=%+v", events)
	}
}

func TestApplyDefersWhenOffline(t *testing.T) {
	fs := newFakeStore()
	fs.endpoints["gh-a"] = store.Endpoint{RESTBaseURL: "http://gh-a"}
	fr := &fakeRelay{}
	fh := &fakeHub{}
	r := newTestReconciler(fs, fr, fakeFleet{status: map[string]domain.Connectivity{"gh-a": domain.StatusOffline}}, fh)

	outcome, err := r.Apply(context.Background(), "gh-a", domain.Setpoints{TemperatureDayC: 24}, domain.SourceOperatorEdit, "operator", "edit")
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if !outcome.Deferred || outcome.Revision != 1 {
		t.Fatalf("outcome=%+v want deferred rev1", outcome)
	}
	if len(fr.calls) != 0 {
		t.Fatalf("offline apply must not contact the controller, got %+v", fr.calls)
	}
	recon := fs.recon["gh-a"]
	if recon.DeliveryStatus != store.DeliveryDeferred || recon.LastDeliveredRevision != nil {
		t.Fatalf("recon=%+v want deferred, nothing delivered", recon)
	}
}

func TestApplyControllerRejectsIsNotRecorded(t *testing.T) {
	fs := newFakeStore()
	fs.endpoints["gh-a"] = store.Endpoint{RESTBaseURL: "http://gh-a"}
	fr := &fakeRelay{responder: func(string, string) (relay.Response, error) {
		return relay.Response{Status: http.StatusUnprocessableEntity, Body: []byte(`{"error":"bad"}`)}, nil
	}}
	r := newTestReconciler(fs, fr, onlineFleet("gh-a"), &fakeHub{})

	outcome, err := r.Apply(context.Background(), "gh-a", domain.Setpoints{}, domain.SourceOperatorEdit, "operator", "edit")
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if outcome.ControllerStatus != http.StatusUnprocessableEntity || outcome.Delivered || outcome.Revision != 0 {
		t.Fatalf("outcome=%+v want 422 not recorded", outcome)
	}
	if len(fs.revisions["gh-a"]) != 0 {
		t.Fatal("a rejected edit must not become intended state")
	}
}

func TestApplyUnknownGreenhouse(t *testing.T) {
	fs := newFakeStore()
	r := newTestReconciler(fs, &fakeRelay{}, onlineFleet("gh-a"), &fakeHub{})
	if _, err := r.Apply(context.Background(), "ghost", domain.Setpoints{}, domain.SourceProfile, "", ""); err != ErrUnknownGreenhouse {
		t.Fatalf("err=%v want ErrUnknownGreenhouse", err)
	}
}

// --- reconcile loop ---

func seedDelivered(fs *fakeStore, id string, intended domain.Setpoints) {
	fs.greenhouses = append(fs.greenhouses, store.Greenhouse{ID: id})
	fs.endpoints[id] = store.Endpoint{RESTBaseURL: "http://" + id}
	fs.revisions[id] = []domain.SetpointRevision{{GreenhouseID: id, Revision: 1, Setpoints: intended}}
	delivered := int64(1)
	fs.recon[id] = store.ReconState{GreenhouseID: id, DeliveryStatus: store.DeliveryDelivered, LastDeliveredRevision: &delivered}
}

func TestReconcileReassertsWhenNotDelivered(t *testing.T) {
	fs := newFakeStore()
	fs.greenhouses = []store.Greenhouse{{ID: "gh-a"}}
	fs.endpoints["gh-a"] = store.Endpoint{RESTBaseURL: "http://gh-a"}
	setpoints := domain.Setpoints{TemperatureDayC: 24, Zones: []domain.ZoneTargets{{ZoneID: "z1"}}}
	fs.revisions["gh-a"] = []domain.SetpointRevision{{GreenhouseID: "gh-a", Revision: 1, Setpoints: setpoints}}
	fs.recon["gh-a"] = store.ReconState{GreenhouseID: "gh-a", DeliveryStatus: store.DeliveryDeferred} // held while offline
	fr := &fakeRelay{responder: okController("gh-a", setpoints)}
	r := newTestReconciler(fs, fr, onlineFleet("gh-a"), &fakeHub{})

	r.ReconcileOnce(context.Background())

	recon := fs.recon["gh-a"]
	if recon.DeliveryStatus != store.DeliveryDelivered || recon.LastDeliveredRevision == nil || *recon.LastDeliveredRevision != 1 {
		t.Fatalf("recon=%+v want delivered rev1 after reconnect", recon)
	}
	if fr.patchCount() == 0 {
		t.Fatal("expected a re-assert PATCH")
	}
}

func TestReconcileHoldsWhenOffline(t *testing.T) {
	fs := newFakeStore()
	fs.greenhouses = []store.Greenhouse{{ID: "gh-a"}}
	fs.endpoints["gh-a"] = store.Endpoint{RESTBaseURL: "http://gh-a"}
	fs.revisions["gh-a"] = []domain.SetpointRevision{{GreenhouseID: "gh-a", Revision: 1, Setpoints: domain.Setpoints{TemperatureDayC: 24}}}
	fr := &fakeRelay{}
	r := newTestReconciler(fs, fr, fakeFleet{status: map[string]domain.Connectivity{"gh-a": domain.StatusOffline}}, &fakeHub{})

	r.ReconcileOnce(context.Background())

	if fr.patchCount() != 0 {
		t.Fatal("offline greenhouse must not be contacted for delivery")
	}
	if fs.recon["gh-a"].DeliveryStatus != store.DeliveryDeferred {
		t.Fatalf("recon=%+v want deferred", fs.recon["gh-a"])
	}
}

func TestReconcileDetectsDrift(t *testing.T) {
	fs := newFakeStore()
	seedDelivered(fs, "gh-a", domain.Setpoints{TemperatureDayC: 24})
	// The controller reports a different day temperature than intended.
	reportedGlobal, _ := globalSetpointsBody(domain.Setpoints{TemperatureDayC: 30})
	fr := &fakeRelay{responder: func(method, path string) (relay.Response, error) {
		switch {
		case method == http.MethodGet && path == controllerSetpointsPath("gh-a"):
			return relay.Response{Status: http.StatusOK, Body: reportedGlobal}, nil
		case method == http.MethodGet && path == controllerZonesPath("gh-a"):
			return relay.Response{Status: http.StatusOK, Body: []byte("[]")}, nil
		default:
			return relay.Response{Status: http.StatusOK, Body: reportedGlobal}, nil
		}
	}}
	fh := &fakeHub{}
	r := newTestReconciler(fs, fr, onlineFleet("gh-a"), fh)

	r.ReconcileOnce(context.Background())

	if !fs.recon["gh-a"].Drift {
		t.Fatalf("drift not flagged: %+v", fs.recon["gh-a"])
	}
	drifts := fh.driftFrames()
	if len(drifts) != 1 || !drifts[0].Drift {
		t.Fatalf("want one drift(true) frame, got %+v", drifts)
	}
	kinds := fs.eventKinds()
	if len(kinds) != 1 || kinds[0] != "drift" {
		t.Fatalf("event kinds=%v want [drift]", kinds)
	}
	if fr.patchCount() == 0 {
		t.Fatal("expected a drift-correction PATCH")
	}
}

func TestReconcileClearsDriftWhenSynced(t *testing.T) {
	fs := newFakeStore()
	intended := domain.Setpoints{TemperatureDayC: 24}
	seedDelivered(fs, "gh-a", intended)
	recon := fs.recon["gh-a"]
	first := time.Now().UTC()
	recon.Drift = true
	recon.DriftFirstSeen = &first
	fs.recon["gh-a"] = recon
	fr := &fakeRelay{responder: okController("gh-a", intended)} // controller matches intended
	fh := &fakeHub{}
	r := newTestReconciler(fs, fr, onlineFleet("gh-a"), fh)

	r.ReconcileOnce(context.Background())

	if fs.recon["gh-a"].Drift {
		t.Fatalf("drift should clear once synced: %+v", fs.recon["gh-a"])
	}
	drifts := fh.driftFrames()
	if len(drifts) != 1 || drifts[0].Drift {
		t.Fatalf("want one drift(false) frame, got %+v", drifts)
	}
}

func TestReconcileRateLimitsPersistentDrift(t *testing.T) {
	fs := newFakeStore()
	seedDelivered(fs, "gh-a", domain.Setpoints{TemperatureDayC: 24})
	recon := fs.recon["gh-a"]
	recon.Drift = true
	recon.FailCount = 3 // == MaxRetries: stop fighting
	fs.recon["gh-a"] = recon
	reportedGlobal, _ := globalSetpointsBody(domain.Setpoints{TemperatureDayC: 30})
	fr := &fakeRelay{responder: func(method, path string) (relay.Response, error) {
		if method == http.MethodGet && path == controllerZonesPath("gh-a") {
			return relay.Response{Status: http.StatusOK, Body: []byte("[]")}, nil
		}
		return relay.Response{Status: http.StatusOK, Body: reportedGlobal}, nil
	}}
	r := newTestReconciler(fs, fr, onlineFleet("gh-a"), &fakeHub{})

	r.ReconcileOnce(context.Background())

	if fr.patchCount() != 0 {
		t.Fatalf("persistent drift past MaxRetries must not be re-fought, got %d PATCH calls", fr.patchCount())
	}
	if !fs.recon["gh-a"].Drift {
		t.Fatal("persistent drift should stay surfaced")
	}
}
