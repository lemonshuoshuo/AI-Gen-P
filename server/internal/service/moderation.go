package service

import (
	"strings"
	"unicode"
)

// Limits of the admin's sensitive-word list (屏蔽词); further or longer
// words are ignored.
const (
	maxSensitiveWords   = 5000
	maxSensitiveWordLen = 50 // runes, after normalizeText
)

// normalizeText prepares text for sensitive-word matching: lower case,
// full-width ASCII as half-width, without spaces, invisible (control and
// zero-width) characters, punctuation and symbols, so that variants such as
// "博 彩", "博*彩" or full-width letters still match.
func normalizeText(s string) []rune {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		if r >= 0xFF01 && r <= 0xFF5E {
			r -= 0xFEE0
		}
		if unicode.IsSpace(r) || unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || unicode.IsPunct(r) || unicode.IsSymbol(r) {
			continue
		}
		out = append(out, unicode.ToLower(r))
	}
	return out
}

// wordTrie is a node of a wordMatcher.
type wordTrie struct {
	next map[rune]*wordTrie
	word string // the word as listed, when one ends here
}

// wordMatcher finds sensitive words in text (compared after normalizeText).
// A nil matcher matches nothing.
type wordMatcher struct {
	root   wordTrie
	maxLen int
}

// buildWordMatcher builds a matcher for a list of words separated by line
// breaks or commas; nil when the list has no words.
func buildWordMatcher(list string) *wordMatcher {
	m := &wordMatcher{}
	n := 0
	for _, w := range strings.FieldsFunc(list, func(r rune) bool { return r == '\n' || r == ',' || r == '，' }) {
		w = strings.TrimSpace(w)
		key := normalizeText(w)
		if len(key) == 0 || len(key) > maxSensitiveWordLen {
			continue
		}
		if n++; n > maxSensitiveWords {
			break
		}
		node := &m.root
		for _, r := range key {
			if node.next == nil {
				node.next = map[rune]*wordTrie{}
			}
			child := node.next[r]
			if child == nil {
				child = &wordTrie{}
				node.next[r] = child
			}
			node = child
		}
		if node.word == "" {
			node.word = w
		}
		m.maxLen = max(m.maxLen, len(key))
	}
	if m.maxLen == 0 {
		return nil
	}
	return m
}

// find returns the first listed word contained in text, or "".
func (m *wordMatcher) find(text string) string {
	if m == nil || text == "" {
		return ""
	}
	rs := normalizeText(text)
	for i := range rs {
		node := &m.root
		for j := i; j < len(rs) && j-i < m.maxLen; j++ {
			if node = node.next[rs[j]]; node == nil {
				break
			}
			if node.word != "" {
				return node.word
			}
		}
	}
	return ""
}
