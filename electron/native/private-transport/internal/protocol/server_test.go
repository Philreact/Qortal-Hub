package protocol

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestMalformedAndUnsupportedRequestsFailSafely(t *testing.T) {
	tests := []struct {
		name string
		line string
		code string
	}{
		{"malformed JSON", "{", "MALFORMED_JSON"},
		{"missing request ID", `{"version":2,"operation":"health"}`, "MISSING_REQUEST_ID"},
		{"unsupported version", `{"version":1,"requestId":"v1","operation":"health"}`, "UNSUPPORTED_VERSION"},
		{"unknown operation", `{"version":2,"requestId":"unknown","operation":"exec"}`, "UNKNOWN_OPERATION"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			response, shutdown := NewServer().Handle(context.Background(), []byte(tt.line))
			if shutdown || response.OK || response.Error == nil || response.Error.Code != tt.code {
				t.Fatalf("unexpected response: %#v", response)
			}
		})
	}
}

func TestInnerErrorCodeDistinguishesRelayAndBackendCertificates(t *testing.T) {
	if got := innerErrorCode(errors.New("MASQUE_TUNNEL_FAILED: relay certificate pin mismatch")); got != "MASQUE_TUNNEL_FAILED" {
		t.Fatalf("relay error mapped to %q", got)
	}
	if got := innerErrorCode(errors.New("INNER_QUIC_FAILED: backend certificate pin mismatch")); got != "BACKEND_IDENTITY_MISMATCH" {
		t.Fatalf("backend error mapped to %q", got)
	}
}

func TestMoqErrorCodeDistinguishesRelayAndBackendCertificates(t *testing.T) {
	if got := moqErrorCode(errors.New("MASQUE_TUNNEL_FAILED: relay certificate pin mismatch")); got != "MASQUE_TUNNEL_FAILED" {
		t.Fatalf("relay error mapped to %q", got)
	}
	if got := moqErrorCode(errors.New("MOQ_QUIC_FAILED: backend certificate pin mismatch")); got != "BACKEND_IDENTITY_MISMATCH" {
		t.Fatalf("backend error mapped to %q", got)
	}
}

func TestMoqOperationsRejectUnknownSessions(t *testing.T) {
	server := NewServer()
	for index, request := range []string{
		`{"version":2,"requestId":"subscribe","operation":"subscribeMoqTrack","params":{"moqSessionId":"missing","subscriptionId":"subscription-1","namespace":["qortal","apps"],"trackName":"realtime"}}`,
		`{"version":2,"requestId":"publish","operation":"publishMoqObject","params":{"moqSessionId":"missing"}}`,
		`{"version":2,"requestId":"metrics","operation":"moqSessionMetrics","params":{"moqSessionId":"missing"}}`,
		`{"version":2,"requestId":"close","operation":"closeMoqSession","params":{"moqSessionId":"missing"}}`,
	} {
		response, shutdown := server.Handle(context.Background(), []byte(request))
		if shutdown || response.OK || response.Error == nil || response.Error.Code != "MOQ_SESSION_CLOSED" {
			t.Fatalf("request %d did not fail closed: %#v", index, response)
		}
	}
}

func TestAudioSpecificMoqOperationsAreNotAvailable(t *testing.T) {
	for _, operation := range []string{
		"openCallMediaSession", "subscribeCallMediaTrack", "publishCallMediaDatagram",
		"setCallMediaSendKey", "setCallMediaReceiveKey", "removeCallMediaReceiveKey",
		"publishCallAudioFrame", "callMediaSessionMetrics", "closeCallMediaSession",
	} {
		request := `{"version":2,"requestId":"old-` + operation + `","operation":"` + operation + `","params":{}}`
		response, shutdown := NewServer().Handle(context.Background(), []byte(request))
		if shutdown || response.OK || response.Error == nil || response.Error.Code != "UNKNOWN_OPERATION" {
			t.Fatalf("operation %q did not fail closed: %#v", operation, response)
		}
	}
}

func TestDuplicateRequestIDFails(t *testing.T) {
	server := NewServer()
	request := []byte(`{"version":2,"requestId":"same","operation":"health"}`)
	first, _ := server.Handle(context.Background(), request)
	second, _ := server.Handle(context.Background(), request)
	if !first.OK || second.OK || second.Error == nil || second.Error.Code != "DUPLICATE_REQUEST_ID" {
		t.Fatalf("unexpected responses: first=%#v second=%#v", first, second)
	}
}

func TestOversizedControlMessageFailsWithoutPanic(t *testing.T) {
	input := strings.NewReader(strings.Repeat("x", MaxControlMessageBytes+1) + "\n")
	var output bytes.Buffer
	if err := NewServer().Serve(context.Background(), input, &output); err != nil {
		t.Fatal(err)
	}
	var response Response
	if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &response); err != nil {
		t.Fatal(err)
	}
	if response.OK || response.Error == nil || response.Error.Code != "CONTROL_MESSAGE_TOO_LARGE" {
		t.Fatalf("unexpected response: %#v", response)
	}
}

func TestMalformedAndOversizedBinaryFramesFailClosed(t *testing.T) {
	for _, input := range []string{
		`{"version":2,"requestId":"truncated","operation":"sendPrivateReliable","params":{},"binaryLength":5}` + "\nxx",
		`{"version":2,"requestId":"oversized","operation":"sendPrivateReliable","params":{},"binaryLength":65537}` + "\n",
	} {
		var output bytes.Buffer
		if err := NewServer().Serve(context.Background(), strings.NewReader(input), &output); err != nil {
			t.Fatal(err)
		}
		var response Response
		if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &response); err != nil {
			t.Fatal(err)
		}
		if response.OK || response.Error == nil {
			t.Fatalf("unexpected response: %#v", response)
		}
	}
}
