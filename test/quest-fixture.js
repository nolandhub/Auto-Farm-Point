/**
 * Markup shaped after the real rewards.bing.com pages (2026-09-28): the Earn
 * page links each quest, and a quest page renders its header as HTML and its
 * activities as React Server Component data inside a JS string.
 */

export const MONTHLY = "ENWW_pcparent_FY27_BingMonthlyPC_Sep_punchcard";
export const APP_WEEKLY = "WW_pcparent_RewardsApp_weekly_Exclusive_Septw4_2026_punchcard";

export const EARN_HTML = `<a class="card" href="/earn/quest/${APP_WEEKLY}" tabindex="0">
<a class="card" data-rac="" href="/earn/quest/${MONTHLY}" tabindex="0">
<a href="/earn/quest/${MONTHLY}">again</a>`;

export const child = (n, { done = false, locked = false, label = "See the schedule, Stay ready for NFL season" } = {}) =>
  String.raw`[\"$\",\"$L4e\",null,{\"ariaLabel\":\"${label}\",\"hash\":\"${String(n).repeat(64).slice(0, 64)}\",\"href\":\"https://www.bing.com/search?q=NFL+Schedule+2026\u0026form=ML2Y1K\u0026OCID=ML2Y1K\u0026PUBL=RewardsDO\u0026CREA=ML2Y1K\u0026rnoreward=1\",\"edgeAction\":\"$undefined\",\"isCompleted\":${done},\"isLocked\":${locked},\"linkText\":\"See the schedule\",\"offerId\":\"ENWW_pcchild${n}_urlreward_FY27_BingMonthlyPC_Sep_punchcard\"}]`;

export function questHtml({
  title = "Discover trending September ideas for fashion, sports, travel and online education",
  progress = "1/4",
  children = [],
  points = "50",
  description = "Earn 50 Rewards points when you complete all four activities.",
} = {}) {
  return `<div><h1 class="text-pageHeader">${title}</h1>
<p class="line-clamp-3 text-readingBody">${description}</p>
${points === null ? "" : `<p class="text-statusInformativeTintFg text-globalBody2">+<!-- -->${points}</p>`}</div>
<p class="text-itemHeader">Status:</p><div class="grow sm:grow-0"></div><p class="text-itemBody">${progress} tasks</p>
<script>self.__next_f.push([1,"4a:[\\"$\\",\\"$L5e\\",null,{\\"expiresAt\\":\\"$D2026-10-01T07:00:00.000Z\\",\\"includeIcon\\":true}]\\n${children.join("\\n")}"])</script>`;
}
