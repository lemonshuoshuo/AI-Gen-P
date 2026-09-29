package service

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"triphub/internal/ai"
)

// PreferencesRequest is the input of AIPreferences.
type PreferencesRequest struct {
	Destination string
	Days        int    // 0: not given
	StartDate   string // YYYY-MM-DD or ""
	Together    bool   // travelling as a couple
	Draft       string // what the user has written so far
}

// PreferencesResult are suggestions for the 偏好和要求 of an AI plan.
type PreferencesResult struct {
	// Suggestions are 3–5 short sentences the user can add one by one.
	Suggestions []string `json:"suggestions"`
	// Text is the draft and the best suggestions as one paragraph.
	Text string `json:"text"`
}

// PreferencesTimeout bounds AIPreferences (or TRIPHUB_AI_TIMEOUT when
// shorter): the user waits for it in the planning form.
const PreferencesTimeout = 20 * time.Second

// Limits of the suggestions.
const (
	maxPreferenceSuggestions = 5
	maxSuggestionRunes       = 40
	maxPreferencesText       = 300 // the preferences field of POST /ai/plan
)

// AIPreferences asks the model for preference sentences for an AI plan to
// the destination (pace, budget, company, food, photos…), without
// thinking, and a paragraph that merges them with the user's draft.
func (s *Service) AIPreferences(ctx context.Context, req PreferencesRequest) (*PreferencesResult, error) {
	var b strings.Builder
	fmt.Fprintf(&b, "目的地：%s\n", promptText(req.Destination, 30))
	if req.Days > 0 {
		fmt.Fprintf(&b, "天数：%d 天\n", req.Days)
	}
	if req.StartDate != "" {
		if t, err := time.Parse("2006-01-02", req.StartDate); err == nil {
			fmt.Fprintf(&b, "出发日期：%s（%s）\n", req.StartDate, seasonOf(t.Month()))
		}
	}
	if req.Together {
		b.WriteString("同行：情侣两人\n")
	}
	draft := promptText(req.Draft, maxPreferencesText)
	if draft != "" {
		fmt.Fprintf(&b, "用户已写的偏好：「%s」\n", draft)
	} else {
		b.WriteString("用户还没有写偏好。\n")
	}
	b.WriteString(`请帮用户写 AI 行程规划的「偏好和要求」：
1. suggestions：4 条不同方面的偏好（从节奏、预算、同行人、饮食口味、拍照打卡、兴趣主题、交通、住宿中挑选，结合目的地特色和季节），每条是用户可以直接加进偏好里的一句中文短句，10–30 字，如「节奏轻松，每天不超过 4 个景点」「想吃地道的海鲜小吃」；不要重复用户已写的内容，不要编造具体价格以外的事实。
2. text：把用户已写的偏好（如有）和最合适的 2 条建议整合成一段通顺的偏好描述，不超过 120 字，保留用户原有的意思。
只输出 JSON：{"suggestions":["…"],"text":"…"}`)
	system := "你是一名熟悉中国各地的旅行规划助手，帮用户把出行偏好写清楚。" + communityTextRule + "回答必须是严格的 JSON，不要输出其他内容。"

	actx, cancel := context.WithTimeout(ctx, min(PreferencesTimeout, s.Cfg.AITimeout))
	defer cancel()
	temp := 0.7
	text, err := s.AI.Complete(actx, []ai.Message{{Role: "system", Content: system}, {Role: "user", Content: b.String()}},
		ai.Options{JSON: true, MaxTokens: 600, Temperature: &temp, Thinking: ai.ThinkingOff})
	if err != nil {
		return nil, err
	}
	var reply struct {
		Suggestions []string `json:"suggestions"`
		Text        string   `json:"text"`
	}
	if err := ai.DecodeJSON(text, &reply); err != nil {
		return nil, err
	}
	out := &PreferencesResult{Suggestions: []string{}}
	for _, sg := range reply.Suggestions {
		sg = strings.Trim(promptText(sg, 200), " 。；;，,")
		if sg == "" || slices.Contains(out.Suggestions, Truncate(sg, maxSuggestionRunes)) {
			continue
		}
		if draft != "" && strings.Contains(draft, sg) {
			continue // already written
		}
		out.Suggestions = append(out.Suggestions, Truncate(sg, maxSuggestionRunes))
		if len(out.Suggestions) == maxPreferenceSuggestions {
			break
		}
	}
	out.Text = Truncate(promptText(reply.Text, 1000), maxPreferencesText)
	if len(out.Suggestions) == 0 && out.Text == "" {
		return nil, ErrNoSuggestions
	}
	return out, nil
}

// ErrNoSuggestions: the model answered without any usable suggestion.
var ErrNoSuggestions = errors.New("ai gave no suggestions")
