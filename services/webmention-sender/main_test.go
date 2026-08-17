package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/aws/aws-lambda-go/events"
)

func TestDiscoverWebmentionEndpoint(t *testing.T) {
	// Test Case 1: Endpoint in HTTP Link Header
	t.Run("LinkHeader", func(t *testing.T) {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Link", `<http://example.com/webmention-endpoint>; rel="webmention"`)
			w.WriteHeader(http.StatusOK)
		}))
		defer ts.Close()

		endpoint, err := discoverWebmentionEndpoint(ts.URL)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if endpoint != "http://example.com/webmention-endpoint" {
			t.Errorf("expected http://example.com/webmention-endpoint, got %s", endpoint)
		}
	})

	// Test Case 2: Endpoint in HTML <link> tag
	t.Run("LinkTag", func(t *testing.T) {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`
				<html>
				<head>
					<link rel="webmention" href="/relative-endpoint" />
				</head>
				<body></body>
				</html>
			`))
		}))
		defer ts.Close()

		endpoint, err := discoverWebmentionEndpoint(ts.URL)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		expected := ts.URL + "/relative-endpoint"
		if endpoint != expected {
			t.Errorf("expected %s, got %s", expected, endpoint)
		}
	})

	// Test Case 3: Endpoint in HTML <a> tag
	t.Run("ATag", func(t *testing.T) {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`
				<html>
				<body>
					<p>Send me webmentions at <a rel="webmention" href="https://endpoint.com/web">here</a></p>
				</body>
				</html>
			`))
		}))
		defer ts.Close()

		endpoint, err := discoverWebmentionEndpoint(ts.URL)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if endpoint != "https://endpoint.com/web" {
			t.Errorf("expected https://endpoint.com/web, got %s", endpoint)
		}
	})

	// Test Case 4: No Endpoint Found
	t.Run("NotFound", func(t *testing.T) {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`<html><body>No links here</body></html>`))
		}))
		defer ts.Close()

		_, err := discoverWebmentionEndpoint(ts.URL)
		if err == nil {
			t.Fatal("expected error, got nil")
		}
	})
}

func TestHandlerWithBypass(t *testing.T) {
	os.Setenv("BYPASS_DISPATCH", "true")
	defer os.Unsetenv("BYPASS_DISPATCH")

	getReceived := false

	// Target Server
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		getReceived = true
		w.Header().Set("Link", `<http://endpoint-fake.com/post>; rel="webmention"`)
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	payload := WebmentionPayload{
		Source: "https://mysite.com/post-one",
		Target: ts.URL,
	}
	payloadBytes, _ := json.Marshal(payload)

	snsEvent := events.SNSEvent{
		Records: []events.SNSEventRecord{
			{
				SNS: events.SNSEntity{
					Message: string(payloadBytes),
				},
			},
		},
	}

	err := handler(context.Background(), snsEvent)
	if err != nil {
		t.Fatalf("unexpected error from handler: %v", err)
	}

	if !getReceived {
		t.Error("expected target GET discovery request to be made, but it wasn't")
	}
}

func TestHandlerWithoutBypass(t *testing.T) {
	// Set BYPASS_DISPATCH to false explicitly
	os.Setenv("BYPASS_DISPATCH", "false")
	defer os.Unsetenv("BYPASS_DISPATCH")

	endpointReceived := false
	var receivedSource, receivedTarget string

	// Endpoint Server
	endpointTs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			endpointReceived = true
			_ = r.ParseForm()
			receivedSource = r.Form.Get("source")
			receivedTarget = r.Form.Get("target")
			w.WriteHeader(http.StatusAccepted)
		}
	}))
	defer endpointTs.Close()

	// Target Server
	targetTs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Link", `<`+endpointTs.URL+`>; rel="webmention"`)
		w.WriteHeader(http.StatusOK)
	}))
	defer targetTs.Close()

	payload := WebmentionPayload{
		Source: "https://mysite.com/post-one",
		Target: targetTs.URL,
	}
	payloadBytes, _ := json.Marshal(payload)

	snsEvent := events.SNSEvent{
		Records: []events.SNSEventRecord{
			{
				SNS: events.SNSEntity{
					Message: string(payloadBytes),
				},
			},
		},
	}

	err := handler(context.Background(), snsEvent)
	if err != nil {
		t.Fatalf("unexpected error from handler: %v", err)
	}

	if !endpointReceived {
		t.Error("expected Webmention POST request to endpoint to be made, but it wasn't")
	}
	if receivedSource != "https://mysite.com/post-one" {
		t.Errorf("expected source https://mysite.com/post-one, got %s", receivedSource)
	}
	if receivedTarget != targetTs.URL {
		t.Errorf("expected target %s, got %s", targetTs.URL, receivedTarget)
	}
}
