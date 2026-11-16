# To-do dedupe fixture

`messages.jsonl` is a labelled set for to-do duplicate detection: each line is one to-do a desk agent extracted from one email or chat message. The store must decide whether it is the SAME task as one it already holds or a DIFFERENT one. It measures precision (never merge two different tasks, target >= 0.98) and recall (catch real repeats, target >= 0.9).

Fields: `messageId` (shared by the 2-3 to-dos of one message), `threadId` (one email or chat conversation; a fresh email about the same thing gets a new id), `contactId` (sender), `day` (0 = 2026-11-01 through 45, non-decreasing) and `minute` (0-1439), `title` (the extracted imperative line), `due` (YYYY-MM-DD or null), `task` (ground-truth id of the real-world task).

How it was made: every thread, title, due date and label was written by hand for one fictional household (two adults, two school-age kids, a dog, a renter and agency project lead in an invented town). Each line was labelled the way a careful human would read it, with the whole thread in view, before and independently of any dedupe rule. A small script only sorted messages by time and numbered the ids. All people, companies, places, invoice and ticket numbers are invented; there are no email addresses or phone numbers.

Counts:
- 530 lines, 476 messages (51 yield 2-3 to-dos), 183 threads, 84 contacts.
- 219 tasks: 83 appear once (38%), 136 repeat (9 twice, 88 three times, 30 four times, 9 five times).
- 311 repeat lines: 249 in the same thread (238 within 14 days of the previous mention), 23 from the same contact in a new thread, 39 from another contact (partner pings, assistants chasing for their boss, portals, accounts payable).
- Hard negatives: 64 hand-picked groups of confusable tasks (other month, amount, invoice or ticket number, child, person, place, client) cover 160 tasks and 390 lines; 52 threads hold two or more different tasks (315 lines); 501 lines fall in at least one of the two.
- 4 exact titles are shared by different tasks (recurring monthly notices); they differ only by thread and due date.

Typos, "Reminder:" / "Follow up:" prefixes, dropped or added details, and 3-line messages are all deliberate.
