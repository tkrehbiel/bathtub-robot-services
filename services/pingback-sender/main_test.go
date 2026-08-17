package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/events"
)

func TestEscapeXML(t *testing.T) {
	escaped := escapeXML("https://example.com/post?id=1&name=test<val>")
	expected := "https://example.com/post?id=1&amp;name=test&lt;val&gt;"
	if escaped != expected {
		t.Errorf("expected %s, got %s", expected, escaped)
	}
}

func TestDiscoverPingbackEndpoint(t *testing.T) {
	// Test Case 1: Endpoint in X-Pingback Header
	t.Run("X-PingbackHeader", func(t *testing.T) {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Pingback", "http://example.com/xmlrpc")
			w.WriteHeader(http.StatusOK)
		}))
		defer ts.Close()

		endpoint, err := discoverPingbackEndpoint(ts.URL)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if endpoint != "http://example.com/xmlrpc" {
			t.Errorf("expected http://example.com/xmlrpc, got %s", endpoint)
		}
	})

	// Test Case 2: Endpoint in HTML <link> tag
	t.Run("LinkTag", func(t *testing.T) {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`
				<html>
				<head>
					<link rel="pingback" href="/xmlrpc" />
				</head>
				<body></body>
				</html>
			`))
		}))
		defer ts.Close()

		endpoint, err := discoverPingbackEndpoint(ts.URL)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		expected := ts.URL + "/xmlrpc"
		if endpoint != expected {
			t.Errorf("expected %s, got %s", expected, endpoint)
		}
	})

	// Test Case 3: Webmention Supported in Header (Should skip Pingback)
	t.Run("WebmentionHeaderPriority", func(t *testing.T) {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Link", `<http://example.com/webmention>; rel="webmention"`)
			w.Header().Set("X-Pingback", "http://example.com/xmlrpc")
			w.WriteHeader(http.StatusOK)
		}))
		defer ts.Close()

		_, err := discoverPingbackEndpoint(ts.URL)
		if !errors.Is(err, ErrWebmentionSupported) {
			t.Errorf("expected ErrWebmentionSupported, got %v", err)
		}
	})

	// Test Case 4: Webmention Supported in HTML Tag (Should skip Pingback)
	t.Run("WebmentionHTMLPriority", func(t *testing.T) {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`
				<html>
				<head>
					<link rel="webmention" href="/webmention" />
					<link rel="pingback" href="/xmlrpc" />
				</head>
				<body></body>
				</html>
			`))
		}))
		defer ts.Close()

		_, err := discoverPingbackEndpoint(ts.URL)
		if !errors.Is(err, ErrWebmentionSupported) {
			t.Errorf("expected ErrWebmentionSupported, got %v", err)
		}
	})
}

func TestSendPingback(t *testing.T) {
	// Test Case 1: Success Response
	t.Run("Success", func(t *testing.T) {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`<?xml version="1.0"?>
				<methodResponse>
					<params>
						<param><value><string>Pingback registered successfully.</string></value></param>
					</params>
				</methodResponse>
			`))
		}))
		defer ts.Close()

		err := sendPingback(ts.URL, "https://source.com", "https://target.com")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	// Test Case 2: Fault Response
	t.Run("Fault", func(t *testing.T) {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`<?xml version="1.0"?>
				<methodResponse>
					<fault>
						<value>
							<struct>
								<member>
									<name>faultCode</name>
									<value><int>48</int></value>
								</member>
								<member>
									<name>faultString</name>
									<value><string>The pingback has already been registered.</string></value>
								</member>
							</struct>
						</value>
					</fault>
				</methodResponse>
			`))
		}))
		defer ts.Close()

		err := sendPingback(ts.URL, "https://source.com", "https://target.com")
		if err == nil {
			t.Fatal("expected error, got nil")
		}
		if !strings.Contains(err.Error(), "The pingback has already been registered") {
			t.Errorf("expected fault message, got error: %v", err)
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
		w.Header().Set("X-Pingback", "http://fake-xmlrpc.com")
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	payload := PingbackPayload{
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
	os.Setenv("BYPASS_DISPATCH", "false")
	defer os.Unsetenv("BYPASS_DISPATCH")

	endpointReceived := false
	var receivedBody string

	// Endpoint Server (XML-RPC)
	endpointTs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			endpointReceived = true
			body, _ := io.ReadAll(r.Body)
			receivedBody = string(body)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`<?xml version="1.0"?><methodResponse><params><param><value><string>Success</string></value></param></params></methodResponse>`))
		}
	}))
	defer endpointTs.Close()

	// Target Server
	targetTs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Pingback", endpointTs.URL)
		w.WriteHeader(http.StatusOK)
	}))
	defer targetTs.Close()

	payload := PingbackPayload{
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
		t.Error("expected XML-RPC POST request to endpoint to be made, but it wasn't")
	}
	if !strings.Contains(receivedBody, "https://mysite.com/post-one") {
		t.Errorf("expected body to contain source URL, got %s", receivedBody)
	}
	if !strings.Contains(receivedBody, targetTs.URL) {
		t.Errorf("expected body to contain target URL, got %s", receivedBody)
	}
}

func TestHandlerWithWebmentionPriority(t *testing.T) {
	os.Setenv("BYPASS_DISPATCH", "false")
	defer os.Unsetenv("BYPASS_DISPATCH")

	endpointReceived := false

	// Target Server that advertises both Webmention and Pingback
	targetTs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Link", `<http://example.com/webmention>; rel="webmention"`)
		w.Header().Set("X-Pingback", "http://example.com/xmlrpc")
		w.WriteHeader(http.StatusOK)
	}))
	defer targetTs.Close()

	payload := PingbackPayload{
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

	if endpointReceived {
		t.Error("expected Pingback POST request to be skipped because Webmention is supported")
	}
}
