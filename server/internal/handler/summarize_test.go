package handler

import (
	"strings"
	"testing"
	"time"
)

func TestSummarize(t *testing.T) {
	md := "<p>你好 <b>世界</b></p>\n\n# 标题\n- 列表 *强调* `代码` [链接](http://x) ![图](http://y)"
	if got := summarize("", md); got != "你好 世界 标题 列表 强调 代码 链接" {
		t.Fatalf("derived summary: %q", got)
	}
	if got := summarize(" 手写 ", md); got != "手写" {
		t.Fatalf("explicit summary: %q", got)
	}
	// Long content is cut on a rune boundary before the regexes run.
	long := strings.Repeat("旅", 5000)
	if got := summarize("", long); got != strings.Repeat("旅", 120)+"…" {
		t.Fatalf("long content: %q", got)
	}
	// Unclosed '<' made the tag pattern rescan the rest of the text for every
	// match: 50,000 characters took about 20 s.
	for _, adv := range []string{strings.Repeat("<*", 25000), strings.Repeat("<字*", 16666)} {
		start := time.Now()
		summarize("", adv)
		mdSymbol.ReplaceAllString(adv, "") // the pattern itself must be linear too
		if d := time.Since(start); d > time.Second {
			t.Fatalf("adversarial content took %v (should be ~10 ms)", d)
		}
	}
}
