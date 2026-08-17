package main

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sns"
)

type PingbackPayload struct {
	Source string `json:"source"`
	Target string `json:"target"`
}

var (
	linkHeaderRe = regexp.MustCompile(`(?i)<([^>]+)>;\s*([^,]+)`)
	relAttrRe    = regexp.MustCompile(`(?i)rel=["']?([^"']+)["']?`)
	hrefAttrRe   = regexp.MustCompile(`(?i)href=["']([^"']+)["']`)
	linkTagRe    = regexp.MustCompile(`(?i)<link\s+([^>]+)`)
	aTagRe       = regexp.MustCompile(`(?i)<a\s+([^>]+)`)

	snsClient       *sns.Client
	successTopicArn string
)

var ErrWebmentionSupported = errors.New("target supports webmention")

func resolveURL(base, ref string) (string, error) {
	baseURIOj, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	refURIOj, err := url.Parse(ref)
	if err != nil {
		return "", err
	}
	return baseURIOj.ResolveReference(refURIOj).String(), nil
}

func parseLinkHeader(headerVal, relValue string) string {
	matches := linkHeaderRe.FindAllStringSubmatch(headerVal, -1)
	for _, match := range matches {
		urlPart := match[1]
		paramsPart := match[2]
		if strings.Contains(strings.ToLower(paramsPart), "rel=") && strings.Contains(strings.ToLower(paramsPart), relValue) {
			return urlPart
		}
	}
	return ""
}

func hasRel(attrs, relValue string) bool {
	relMatch := relAttrRe.FindStringSubmatch(attrs)
	if len(relMatch) > 1 {
		words := strings.Fields(relMatch[1])
		for _, w := range words {
			if strings.ToLower(w) == relValue {
				return true
			}
		}
	}
	return false
}

func findHTMLEndpoint(htmlBody string, isAnchor bool, relValue string) string {
	var tagRe *regexp.Regexp
	if isAnchor {
		tagRe = aTagRe
	} else {
		tagRe = linkTagRe
	}
	matches := tagRe.FindAllStringSubmatch(htmlBody, -1)
	for _, match := range matches {
		attrs := match[1]
		if hasRel(attrs, relValue) {
			hrefMatch := hrefAttrRe.FindStringSubmatch(attrs)
			if len(hrefMatch) > 1 {
				return hrefMatch[1]
			}
		}
	}
	return ""
}

func discoverPingbackEndpoint(targetURL string) (string, error) {
	req, err := http.NewRequest("GET", targetURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "BathtubRobot/1.0 (Pingback Sender; +https://github.com/tkrehbiel/bathtub-robot-services)")

	client := &http.Client{
		Timeout: 10 * time.Second,
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("bad status code: %d", resp.StatusCode)
	}

	for _, link := range resp.Header["Link"] {
		if parseLinkHeader(link, "webmention") != "" {
			return "", ErrWebmentionSupported
		}
	}

	if pingbackHeader := resp.Header.Get("X-Pingback"); pingbackHeader != "" {
		return resolveURL(targetURL, pingbackHeader)
	}

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	bodyStr := string(bodyBytes)

	if findHTMLEndpoint(bodyStr, false, "webmention") != "" || findHTMLEndpoint(bodyStr, true, "webmention") != "" {
		return "", ErrWebmentionSupported
	}

	if endpoint := findHTMLEndpoint(bodyStr, false, "pingback"); endpoint != "" {
		return resolveURL(targetURL, endpoint)
	}

	return "", fmt.Errorf("pingback endpoint not found")
}

func isLocalBypass() bool {
	return os.Getenv("LOCALSTACK_HOSTNAME") != "" || os.Getenv("AWS_ENDPOINT_URL") != "" || os.Getenv("BYPASS_DISPATCH") == "true"
}

func escapeXML(s string) string {
	var buf bytes.Buffer
	if err := xml.EscapeText(&buf, []byte(s)); err != nil {
		return s
	}
	return buf.String()
}

func sendPingback(endpoint, source, target string) error {
	payload := fmt.Sprintf(`<?xml version="1.0"?>
<methodCall>
  <methodName>pingback.ping</methodName>
  <params>
    <param><value><string>%s</string></value></param>
    <param><value><string>%s</string></value></param>
  </params>
</methodCall>`, escapeXML(source), escapeXML(target))

	req, err := http.NewRequest("POST", endpoint, strings.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "text/xml")
	req.Header.Set("User-Agent", "BathtubRobot/1.0 (Pingback Sender; +https://github.com/tkrehbiel/bathtub-robot-services)")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("endpoint returned status %d: %s", resp.StatusCode, string(body))
	}

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	bodyStr := string(bodyBytes)

	if strings.Contains(bodyStr, "<fault>") {
		re := regexp.MustCompile(`(?i)<member>\s*<name>faultString</name>\s*<value>\s*<string>([^<]+)`)
		match := re.FindStringSubmatch(bodyStr)
		if len(match) > 1 {
			return fmt.Errorf("pingback fault: %s", match[1])
		}
		return fmt.Errorf("pingback fault occurred: %s", bodyStr)
	}

	log.Printf("Successfully sent pingback from %s to %s. Status: %d", source, target, resp.StatusCode)
	return nil
}

func publishSuccess(ctx context.Context, mentionType, source, target, endpoint, status string) error {
	if snsClient == nil || successTopicArn == "" {
		return nil
	}

	message := fmt.Sprintf("Successfully processed %s:\n\n- Source Post: %s\n- Target URL: %s\n- Discovered Endpoint: %s\n- Status: %s\n",
		mentionType, source, target, endpoint, status)

	input := &sns.PublishInput{
		TopicArn: &successTopicArn,
		Message:  &message,
	}

	_, err := snsClient.Publish(ctx, input)
	if err != nil {
		return fmt.Errorf("failed to publish SNS message: %v", err)
	}

	log.Printf("Successfully published success notification to SNS topic %s", successTopicArn)
	return nil
}

func handler(ctx context.Context, snsEvent events.SNSEvent) error {
	for _, record := range snsEvent.Records {
		var payload PingbackPayload
		if err := json.Unmarshal([]byte(record.SNS.Message), &payload); err != nil {
			log.Printf("Error unmarshaling message: %v", err)
			continue
		}

		log.Printf("Starting pingback processing from %s to %s", payload.Source, payload.Target)
		endpoint, err := discoverPingbackEndpoint(payload.Target)
		if err != nil {
			if errors.Is(err, ErrWebmentionSupported) {
				log.Printf("[SKIP] Target URL %s supports Webmention. Skipping pingback dispatch to avoid duplication.", payload.Target)
				continue
			}
			log.Printf("Failed to discover pingback endpoint for %s: %v", payload.Target, err)
			continue
		}

		log.Printf("Discovered pingback endpoint %s for %s", endpoint, payload.Target)

		if isLocalBypass() {
			log.Printf("[BYPASS] Bypassing pingback dispatch to endpoint %s for target %s in local stage.", endpoint, payload.Target)
			if err := publishSuccess(ctx, "Pingback", payload.Source, payload.Target, endpoint, "Bypassed (Local Stage)"); err != nil {
				log.Printf("Failed to publish success notification: %v", err)
			}
			continue
		}

		if err := sendPingback(endpoint, payload.Source, payload.Target); err != nil {
			log.Printf("Failed to send pingback: %v", err)
			continue
		}

		if err := publishSuccess(ctx, "Pingback", payload.Source, payload.Target, endpoint, "Sent (Success)"); err != nil {
			log.Printf("Failed to publish success notification: %v", err)
		}
	}
	return nil
}

func main() {
	successTopicArn = os.Getenv("SUCCESS_TOPIC_ARN")
	if successTopicArn != "" {
		ctx := context.TODO()
		cfgOpts := []func(*config.LoadOptions) error{}
		if localstackHost := os.Getenv("LOCALSTACK_HOSTNAME"); localstackHost != "" {
			cfgOpts = append(cfgOpts, config.WithBaseEndpoint("http://"+localstackHost+":4566"))
		} else if awsEndpoint := os.Getenv("AWS_ENDPOINT_URL"); awsEndpoint != "" {
			cfgOpts = append(cfgOpts, config.WithBaseEndpoint(awsEndpoint))
		}

		cfg, err := config.LoadDefaultConfig(ctx, cfgOpts...)
		if err != nil {
			log.Printf("Warning: unable to load AWS config: %v", err)
		} else {
			snsClient = sns.NewFromConfig(cfg)
		}
	}

	lambda.Start(handler)
}
