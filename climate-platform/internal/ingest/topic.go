package ingest

import "strings"

// topicKind classifies an ingested MQTT topic (contracts/mqtt topic map).
type topicKind int

const (
	topicUnknown topicKind = iota
	topicSensorHouse
	topicSensorZone
	topicActuator
	topicFault
	topicState
)

// topicInfo is a parsed `gh/{greenhouse_id}/...` telemetry topic.
type topicInfo struct {
	greenhouseID string
	kind         topicKind
	zoneID       string // topicSensorZone
	metric       string // topicSensor*
	actuator     string // topicActuator
}

// parseTopic decodes a controller telemetry topic. ok is false for any topic that is
// not a recognized `gh/{id}/...` form.
//
//	gh/{id}/sensor/{metric}                -> topicSensorHouse
//	gh/{id}/zone/{zone}/sensor/{metric}    -> topicSensorZone
//	gh/{id}/actuator/{actuator}/state      -> topicActuator
//	gh/{id}/fault                          -> topicFault
//	gh/{id}/state                          -> topicState
func parseTopic(topic string) (topicInfo, bool) {
	parts := strings.Split(topic, "/")
	if len(parts) < 3 || parts[0] != "gh" || parts[1] == "" {
		return topicInfo{}, false
	}
	info := topicInfo{greenhouseID: parts[1]}
	switch {
	case len(parts) == 4 && parts[2] == "sensor":
		info.kind, info.metric = topicSensorHouse, parts[3]
	case len(parts) == 6 && parts[2] == "zone" && parts[4] == "sensor":
		info.kind, info.zoneID, info.metric = topicSensorZone, parts[3], parts[5]
	case len(parts) == 5 && parts[2] == "actuator" && parts[4] == "state":
		info.kind, info.actuator = topicActuator, parts[3]
	case len(parts) == 3 && parts[2] == "fault":
		info.kind = topicFault
	case len(parts) == 3 && parts[2] == "state":
		info.kind = topicState
	default:
		return topicInfo{}, false
	}
	return info, true
}
