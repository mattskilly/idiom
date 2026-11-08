Choose an option and give an explicit human reason for each id. <wording>, <reason>, <build> and <escalation> are input slots, not answers.

Commands carry the current build slug and escalation id as provenance.

1. finding-1 [["site","home","light","decision:card.radius"]] — Card radius: two references disagree.
Surface: site; home/wide/light
Source: /PROJECT/.idiom/reports/run/findings.json
Citation: Designer’s 'reference': "8px" (designs/a.html; https://example.com/design#card)
Citation: prototype: "12px" (designs/b.html)
Evidence: /PROJECT/.idiom/reports/run/home/wide/light/screenshot.png
Evidence: /PROJECT/.idiom/reports/run/crops/card.png
Option: Designer’s 'reference'
  idiom decide --finding finding-1 --choose 'Designer’s '\''reference'\''' --reason '<reason>' --build '<build>' --escalation '<escalation>'
Option: prototype
  idiom decide --finding finding-1 --choose prototype --reason '<reason>' --build '<build>' --escalation '<escalation>'

2. ruling-1 [chip-fingerprint] — How should selection be shown?
Surface: site; ready/wide, done/wide
Source: /PROJECT/.idiom/reports/run/unruled-decisions.json
Citation: Use observable UI behavior.
Citation: {"kind":"law","excerpt":"Use observable UI behavior."}
Evidence: /PROJECT/.idiom/reports/run/ready/wide/screenshot.png
Evidence: /PROJECT/.idiom/reports/run/done/wide/screenshot.png
Crop evidence: unavailable; inspect the listed screenshots.
Option: Selected chips use a filled treatment.
  idiom decide --decision ruling-1 --candidate 1 --reason '<reason>' --build '<build>' --escalation '<escalation>'
Option: Custom rule (supply custom wording)
  idiom decide --decision ruling-1 --wording '<wording>' --reason '<reason>' --build '<build>' --escalation '<escalation>'
Option: No rule needed
  idiom decide --decision ruling-1 --no-rule --reason '<reason>' --build '<build>' --escalation '<escalation>'