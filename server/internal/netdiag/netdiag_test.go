package netdiag

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// get sends GET url with client under a trace and classifies the failure.
func get(t *testing.T, client *http.Client, u string, timeout time.Duration) *Failure {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	tr := NewTrace()
	req, err := http.NewRequestWithContext(tr.Context(ctx), http.MethodGet, u, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.Do(req)
	if err == nil {
		resp.Body.Close()
		t.Fatalf("%s: no error", u)
	}
	return Classify(err, tr, ProxyOf(client, req))
}

func TestClassify(t *testing.T) {
	// Nothing listens: TCP connect.
	closed, _ := net.Listen("tcp", "127.0.0.1:0")
	closedAddr := closed.Addr().String()
	closed.Close()
	f := get(t, &http.Client{}, "http://"+closedAddr+"/", 2*time.Second)
	if f.Layer != LayerConnect || !strings.Contains(f.Reason, "连接被拒绝") || !strings.Contains(f.Reason, closedAddr) {
		t.Fatalf("refused: %+v", f)
	}

	// The host does not resolve.
	dnsFail := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
		return nil, &net.OpError{Op: "dial", Net: "tcp", Err: &net.DNSError{Err: "no such host", Name: "api.example.invalid",
			Server: "127.0.0.11:53", IsNotFound: true}}
	}}}
	f = get(t, dnsFail, "https://api.example.invalid/", 2*time.Second)
	if f.Layer != LayerDNS || !strings.Contains(f.Reason, "api.example.invalid 不存在") || !strings.Contains(f.Reason, "127.0.0.11:53") {
		t.Fatalf("dns: %+v", f)
	}

	// A proxy that is not there (Docker injects 127.0.0.1:7890 from ~/.docker/config.json).
	proxied := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(&url.URL{Scheme: "http", Host: closedAddr,
		User: url.UserPassword("u", "secret")})}}
	f = get(t, proxied, "https://restapi.amap.com/", 2*time.Second)
	if f.Layer != LayerProxy || f.Proxy != "http://***@"+closedAddr || strings.Contains(f.Reason, "secret") ||
		!strings.Contains(f.Reason, "连接被拒绝") {
		t.Fatalf("proxy: %+v", f)
	}

	// Through a proxy the lookups are of the proxy's host: they must not be
	// shown as the addresses of the service.
	_, closedPort, _ := net.SplitHostPort(closedAddr)
	byName := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(&url.URL{Scheme: "http", Host: "localhost:" + closedPort})}}
	f = get(t, byName, "https://restapi.amap.com/", 2*time.Second)
	if f.Layer != LayerProxy || len(f.Addrs) != 0 || len(f.ProxyAddrs) == 0 {
		t.Fatalf("proxy by name: %+v", f)
	}
	if d := FromFailure(f, "x"); len(d.Addrs) != 0 || strings.Join(d.ProxyAddrs, ",") != strings.Join(f.ProxyAddrs, ",") {
		t.Fatalf("proxy details: %+v", d)
	}

	// A certificate nobody trusts (HTTPS interception).
	tlsSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer tlsSrv.Close()
	f = get(t, &http.Client{Transport: &http.Transport{}}, tlsSrv.URL, 2*time.Second)
	if f.Layer != LayerTLS || !strings.Contains(f.Reason, "证书不受信任") {
		t.Fatalf("certificate: %+v", f)
	}

	// TCP works, the TLS handshake never finishes (MTU, firewall).
	silent, _ := net.Listen("tcp", "127.0.0.1:0")
	defer silent.Close()
	go func() {
		for {
			conn, err := silent.Accept()
			if err != nil {
				return
			}
			defer conn.Close()
		}
	}()
	f = get(t, &http.Client{Transport: &http.Transport{}}, "https://"+silent.Addr().String()+"/", 300*time.Millisecond)
	if f.Layer != LayerTLS || !strings.Contains(f.Reason, "TLS 握手超时") {
		t.Fatalf("tls stall: %+v", f)
	}

	// Connected and sent, no answer.
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(2 * time.Second):
		case <-r.Context().Done():
		}
	}))
	defer slow.Close()
	f = get(t, &http.Client{}, slow.URL, 300*time.Millisecond)
	if f.Layer != LayerTimeout || !strings.Contains(f.Reason, "没有收到任何响应") || f.Remote == "" {
		t.Fatalf("no answer: %+v", f)
	}

	for layer, want := range map[string]bool{LayerDNS: true, LayerTimeout: true, LayerHTTP: false, LayerAPI: false, "": false} {
		if IsNetwork(layer) != want {
			t.Errorf("IsNetwork(%q)", layer)
		}
	}
	if Classify(errors.New("x"), nil, nil).Layer != LayerConnect {
		t.Fatal("an untraced error before any connection")
	}
}

func TestRedact(t *testing.T) {
	key := `c549"abc def`
	err := &url.Error{Op: "Get", URL: "https://restapi.amap.com/v3/place/text?keywords=%E5%A4%A9&key=" + url.QueryEscape(key),
		Err: errors.New("dial tcp: lookup restapi.amap.com: no such host")}
	s := ErrorText(err, key)
	if s != `Get "https://restapi.amap.com/v3/place/text": dial tcp: lookup restapi.amap.com: no such host` {
		t.Fatalf("error text: %s", s)
	}
	if got := Redact("GET /v2/search?postStr=x&tk=0123456789abcdef&type=query failed for c549\"abc def", key); strings.Contains(got, "0123456789abcdef") ||
		strings.Contains(got, key) || !strings.Contains(got, "tk=***&type") {
		t.Fatalf("redact: %s", got)
	}
	for in, want := range map[string]string{
		"":                            "",
		"http://127.0.0.1:7890":       "http://127.0.0.1:7890",
		"127.0.0.1:7890":              "http://127.0.0.1:7890",
		"http://user:pw@proxy:3128/x": "http://***@proxy:3128",
		"socks5://10.0.0.2:1080":      "socks5://10.0.0.2:1080",
	} {
		if got := RedactProxy(in); got != want {
			t.Errorf("RedactProxy(%q) = %q, want %q", in, got, want)
		}
	}
	t.Setenv("HTTPS_PROXY", "http://u:p@10.1.2.3:7890")
	t.Setenv("NO_PROXY", "localhost,.internal")
	if p := Proxies(""); p.HTTPS != "http://***@10.1.2.3:7890" || p.No != "localhost,.internal" || !p.Set() ||
		strings.Contains(p.Text(), "u:p") {
		t.Fatalf("proxies: %+v", p)
	}
	if s := BodySnippet([]byte(`<!DOCTYPE html><html><head><meta name="Server" content="CloudWAF"><title> 访问
		被拒绝 </title></head></html>`), 50); s != "HTML 页面「访问 被拒绝」（被 WAF / 防火墙拦截）" {
		t.Fatalf("html body: %s", s)
	}
	if s := BodySnippet([]byte(strings.Repeat("错", 100)), 10); s != "错错错…" {
		t.Fatalf("text body: %s", s)
	}
	// Configured URLs (AI_BASE_URL) in logs and the diagnostics: no
	// credentials, no key-like parameters.
	for in, want := range map[string]string{
		"":                                     "",
		"https://api.deepseek.com":             "https://api.deepseek.com",
		"https://api.deepseek.com/v1/":         "https://api.deepseek.com/v1/",
		"https://user:tok3n@gw.example.com/v1": "https://***@gw.example.com/v1",
		"https://gw.example.com/v1?key=abc123&region=cn#frag": "https://gw.example.com/v1?key=***&region=cn",
		"https://gw.example.com/v1?api-key=abc123":            "https://gw.example.com/v1?api-key=***",
		"not a url sk-secret-value":                           "not a url ***",
	} {
		if got := RedactURL(in, "sk-secret-value"); got != want {
			t.Errorf("RedactURL(%q) = %q, want %q", in, got, want)
		}
	}
	err = &url.Error{Op: "Post", URL: "https://user:***@gw.example.com/v1/chat/completions", Err: errors.New("EOF")}
	if s := ErrorText(err); s != `Post "https://***@gw.example.com/v1/chat/completions": EOF` {
		t.Fatalf("error text with user info: %s", s)
	}
}

func TestFingerprint(t *testing.T) {
	h := Fingerprint("c549b0e3a1d24f6c8e7b9a0d1c2e3f4a", HexKey)
	if h.Length != 32 || h.Head != "c549" || h.Tail != "3f4a" || h.Warning != "" || h.Text != "长度 32 · c549…3f4a" ||
		h.Whitespace || h.Quotes || h.NonASCII || h.NonHex {
		t.Fatalf("clean amap key: %+v", h)
	}
	h = Fingerprint("sk-0123456789abcdef0123456789abcdef", DeepSeekKey)
	if h.Length != 35 || h.Head != "sk-0" || h.NonHex || h.Warning != "" {
		t.Fatalf("deepseek key: %+v", h)
	}
	h = Fingerprint("c549b0e3a1d24f6c8e7b9a0d1c2e3f4a\u200b", HexKey)
	if h.Length != 33 || h.Tail != "f4a<U+200B>" || !h.NonASCII || !h.NonHex || h.Warning == "" ||
		!strings.Contains(h.Text, "含非 ASCII 字符") {
		t.Fatalf("zero-width space: %+v", h)
	}
	h = Fingerprint(`"c549b0e3 a1d24f6c8e7b9a0d1c2e3f4a"`, HexKey)
	if !h.Quotes || !h.Whitespace || !strings.Contains(h.Text, "含引号") {
		t.Fatalf("quoted: %+v", h)
	}
	if h := Fingerprint("proj-Abc_123-xyz-9876", AnyKey); h.Warning != "" || strings.Contains(h.Text, "十六进制") || !h.NonHex {
		t.Fatalf("another provider's key is not judged by DeepSeek's format: %+v", h)
	}
	if h := Fingerprint("short", AnyKey); h.Head != "" || h.Text != "长度 5" {
		t.Fatalf("short key: %+v", h)
	}
	if h := Fingerprint("sk-secret", AnyKey); h.Head != "sk" || h.Tail != "et" {
		t.Fatalf("9 characters: %+v", h)
	}
}
