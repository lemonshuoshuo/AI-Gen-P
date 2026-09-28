package netdiag

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// keyParamRe matches key-like query parameters in URLs inside error texts.
var keyParamRe = regexp.MustCompile(`(?i)([?&](?:key|tk|api_key|api-key|apikey|access_token|token|secret|password|sig|signature)=)[^&\s"'#]*`)

// Redact replaces the secrets (and their URL-encoded forms) and key-like
// query parameters in s with ***.
func Redact(s string, secrets ...string) string {
	for _, k := range secrets {
		if len(k) < 4 {
			continue
		}
		for _, v := range []string{k, url.QueryEscape(k), url.PathEscape(k)} {
			s = strings.ReplaceAll(s, v, "***")
		}
	}
	return keyParamRe.ReplaceAllString(s, "${1}***")
}

// RedactURL renders a configured URL (e.g. TRIPHUB_AI_BASE_URL) for logs
// and the diagnostics: user info (credentials of a gateway) becomes ***,
// the fragment is dropped and key-like query parameters and the secrets
// are masked.
func RedactURL(raw string, secrets ...string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		// Not a URL we can take apart: at least cut credentials before an @.
		s := raw
		if i := strings.Index(s, "://"); i >= 0 {
			if j := strings.IndexByte(s[i+3:], '@'); j >= 0 {
				s = s[:i+3] + "***@" + s[i+3+j+1:]
			}
		}
		return Redact(s, secrets...)
	}
	s := u.Scheme + "://"
	if u.User != nil {
		s += "***@"
	}
	s += u.Host + u.EscapedPath()
	if u.RawQuery != "" {
		s += "?" + u.RawQuery
	}
	return Redact(s, secrets...)
}

// maxErrorText bounds ErrorText.
const maxErrorText = 600

// ErrorText is err.Error() for operators: the query string of a request URL
// is dropped (it holds the key and the search terms), the secrets are
// redacted and the text is bounded.
func ErrorText(err error, secrets ...string) string {
	if err == nil {
		return ""
	}
	s := err.Error()
	var ue *url.Error
	if errors.As(err, &ue) {
		u := ue.URL
		if i := strings.IndexByte(u, '?'); i >= 0 {
			u = u[:i]
		}
		s = strings.Replace(s, ue.Error(), ue.Op+" "+strconv.Quote(RedactURL(u))+": "+ue.Err.Error(), 1)
	}
	s = Redact(s, secrets...)
	if len(s) > maxErrorText {
		cut := maxErrorText
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		s = s[:cut] + "…"
	}
	return s
}

// Proxy is the proxy configuration of the process environment, as Go's HTTP
// client reads it; credentials and paths are removed.
type Proxy struct {
	HTTPS string `json:"https_proxy,omitempty"` // HTTPS_PROXY / https_proxy
	HTTP  string `json:"http_proxy,omitempty"`  // HTTP_PROXY / http_proxy
	No    string `json:"no_proxy,omitempty"`    // NO_PROXY / no_proxy
	// Used is the proxy requests to the service go through ("" = direct).
	Used string `json:"used,omitempty"`
}

// Set reports whether any proxy variable is set.
func (p Proxy) Set() bool { return p.HTTPS != "" || p.HTTP != "" || p.No != "" }

// Text describes p in one line.
func (p Proxy) Text() string {
	var parts []string
	if p.HTTPS != "" {
		parts = append(parts, "HTTPS_PROXY="+p.HTTPS)
	}
	if p.HTTP != "" {
		parts = append(parts, "HTTP_PROXY="+p.HTTP)
	}
	if p.No != "" {
		parts = append(parts, "NO_PROXY="+p.No)
	}
	if len(parts) == 0 {
		return "未设置代理环境变量"
	}
	return strings.Join(parts, "  ")
}

func getEnvAny(names ...string) string {
	for _, n := range names {
		if v := os.Getenv(n); v != "" {
			return v
		}
	}
	return ""
}

// Proxies returns the proxy environment and the proxy that a request to
// target (a URL; "" to skip) goes through with Go's default transport.
func Proxies(target string) Proxy {
	p := Proxy{
		HTTPS: RedactProxy(getEnvAny("HTTPS_PROXY", "https_proxy")),
		HTTP:  RedactProxy(getEnvAny("HTTP_PROXY", "http_proxy")),
		No:    strings.TrimSpace(getEnvAny("NO_PROXY", "no_proxy")),
	}
	if len(p.No) > 200 {
		p.No = strings.ToValidUTF8(p.No[:200], "") + "…"
	}
	if target != "" {
		if u, err := url.Parse(target); err == nil && u.Host != "" {
			if pu, err := http.ProxyFromEnvironment(&http.Request{URL: u}); err == nil && pu != nil {
				p.Used = RedactProxy(pu.String())
			}
		}
	}
	return p
}

// RedactProxy reduces a proxy URL to scheme://host:port without the path;
// a user name and password become ***.
func RedactProxy(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	u, err := url.Parse(v)
	if err != nil || u.Host == "" {
		u, err = url.Parse("http://" + v)
	}
	if err != nil || u.Host == "" {
		return fmt.Sprintf("（无法解析的值，%d 个字符）", utf8.RuneCountInString(v))
	}
	s := u.Scheme + "://" + u.Host
	if u.User != nil {
		s = u.Scheme + "://***@" + u.Host
	}
	return s
}

// KeyFormat is the expected shape of a key.
type KeyFormat int

// Key formats.
const (
	AnyKey      KeyFormat = iota
	HexKey                // 32 hex digits: AMap Web服务 and Tianditu keys
	DeepSeekKey           // sk- and 32 hex digits
)

// KeyHint is a fingerprint of a key that does not reveal it: its length,
// first and last characters and suspicious content.
type KeyHint struct {
	Length     int    `json:"length"` // in characters
	Head       string `json:"head,omitempty"`
	Tail       string `json:"tail,omitempty"`
	Whitespace bool   `json:"whitespace,omitempty"`
	Quotes     bool   `json:"quotes,omitempty"`
	NonASCII   bool   `json:"non_ascii,omitempty"`
	NonHex     bool   `json:"non_hex,omitempty"` // besides an sk- prefix
	// Warning explains a key that does not look like the expected format.
	Warning string `json:"warning,omitempty"`
	Text    string `json:"text"` // e.g. "长度 32 · c549…bd36"
}

// shown renders a rune of a head / tail: invisible and non-ASCII ones as U+XXXX.
func shown(rs []rune) string {
	var b strings.Builder
	for _, r := range rs {
		if r > 0x20 && r < 0x7f {
			b.WriteRune(r)
		} else {
			fmt.Fprintf(&b, "<U+%04X>", r)
		}
	}
	return b.String()
}

// Fingerprint describes key without revealing it: 4 leading and 4 trailing
// characters of keys of 16 or more characters, 2 of shorter ones, none of
// keys under 8 characters.
func Fingerprint(key string, format KeyFormat) KeyHint {
	rs := []rune(key)
	h := KeyHint{Length: len(rs)}
	n := 0
	switch {
	case len(rs) >= 16:
		n = 4
	case len(rs) >= 8:
		n = 2
	}
	if n > 0 {
		h.Head, h.Tail = shown(rs[:n]), shown(rs[len(rs)-n:])
	}
	body := strings.TrimPrefix(key, "sk-")
	for _, r := range key {
		switch {
		case r == ' ' || r == '\t' || r == '\r' || r == '\n' || r == 0x3000 || r == 0xa0:
			h.Whitespace = true
		case strings.ContainsRune("\"'`“”‘’「」", r):
			h.Quotes = true
		}
		if r > 0x7e || r < 0x20 {
			h.NonASCII = true
		}
	}
	for _, r := range body {
		if !strings.ContainsRune("0123456789abcdefABCDEF", r) {
			h.NonHex = true
			break
		}
	}
	var flags []string
	if h.Whitespace {
		flags = append(flags, "含空白字符")
	}
	if h.Quotes {
		flags = append(flags, "含引号")
	}
	if h.NonASCII {
		flags = append(flags, "含非 ASCII 字符")
	}
	if h.NonHex && format != AnyKey {
		flags = append(flags, "含非十六进制字符")
	}
	switch format {
	case HexKey:
		if len(rs) != 32 || h.NonHex || strings.HasPrefix(key, "sk-") {
			h.Warning = fmt.Sprintf("这类 Key 通常是 32 位十六进制字符（0-9、a-f），当前为 %d 个字符", len(rs))
		}
	case DeepSeekKey:
		if !strings.HasPrefix(key, "sk-") || len(rs) != 35 || h.NonHex {
			h.Warning = fmt.Sprintf("DeepSeek 的 Key 通常是 sk- 加 32 位十六进制字符（共 35 个字符），当前为 %d 个字符", len(rs))
		}
	}
	if len(flags) > 0 && h.Warning == "" {
		h.Warning = "Key 中有可疑字符，请检查是否混入了空格、引号或注释"
	}
	h.Text = fmt.Sprintf("长度 %d", h.Length)
	if n > 0 {
		h.Text += " · " + h.Head + "…" + h.Tail
	}
	if len(flags) > 0 {
		h.Text += "（" + strings.Join(flags, "、") + "）"
	}
	return h
}

var titleRe = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)

// BodySnippet summarises an error response body for operators: the title
// of an HTML page (a proxy, firewall or WAF answered instead of the API),
// else at most n bytes of the text.
func BodySnippet(body []byte, n int) string {
	s := strings.TrimSpace(strings.ToValidUTF8(string(body), ""))
	if strings.HasPrefix(s, "<") {
		title := ""
		if m := titleRe.FindStringSubmatch(s); m != nil {
			title = strings.Join(strings.Fields(m[1]), " ")
		}
		out := "HTML 页面"
		if title != "" {
			out += "「" + title + "」"
		}
		if strings.Contains(strings.ToLower(s), "waf") {
			out += "（被 WAF / 防火墙拦截）"
		}
		return out
	}
	if len(s) > n {
		cut := n
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		s = s[:cut] + "…"
	}
	return s
}
