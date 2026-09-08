package masqueclient

import "testing"

func TestTunnelQUICConfigKeepsIdleCallTunnelAlive(t *testing.T) {
	config := tunnelQUICConfig()
	if !config.EnableDatagrams || config.KeepAlivePeriod != tunnelKeepAlivePeriod ||
		config.MaxIdleTimeout != tunnelMaxIdleTimeout {
		t.Fatalf("unexpected idle tunnel config: %#v", config)
	}
}
