package ingest

import "testing"

func TestParseTopic(t *testing.T) {
	cases := []struct {
		topic    string
		ok       bool
		kind     topicKind
		gh       string
		zone     string
		metric   string
		actuator string
	}{
		{"gh/gh-a/sensor/temperature", true, topicSensorHouse, "gh-a", "", "temperature", ""},
		{"gh/gh-a/zone/bench-a/sensor/soil_moisture", true, topicSensorZone, "gh-a", "bench-a", "soil_moisture", ""},
		{"gh/gh-a/actuator/fans/state", true, topicActuator, "gh-a", "", "", "fans"},
		{"gh/gh-a/fault", true, topicFault, "gh-a", "", "", ""},
		{"gh/gh-a/state", true, topicState, "gh-a", "", "", ""},
		{"gh//state", false, topicUnknown, "", "", "", ""},
		{"other/gh-a/state", false, topicUnknown, "", "", "", ""},
		{"gh/gh-a/sensor", false, topicUnknown, "", "", "", ""},
		{"gh/gh-a/actuator/fans", false, topicUnknown, "", "", "", ""},
	}
	for _, c := range cases {
		t.Run(c.topic, func(t *testing.T) {
			info, ok := parseTopic(c.topic)
			if ok != c.ok {
				t.Fatalf("ok = %v, want %v", ok, c.ok)
			}
			if !ok {
				return
			}
			if info.kind != c.kind || info.greenhouseID != c.gh || info.zoneID != c.zone || info.metric != c.metric || info.actuator != c.actuator {
				t.Fatalf("parsed %+v", info)
			}
		})
	}
}
