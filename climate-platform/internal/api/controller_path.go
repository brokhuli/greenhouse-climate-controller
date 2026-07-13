package api

// controllerPath builds a controller REST resource path under its per-greenhouse base,
// e.g. controllerPath("gh-a", "/setpoints") == "/greenhouses/gh-a/setpoints". The relay
// appends this to the registered rest_base_url (the controller host); the platform-controller-control-rest
// contract serves every resource under /greenhouses/{greenhouse_id}.
func controllerPath(greenhouseID, resource string) string {
	return "/greenhouses/" + greenhouseID + resource
}
