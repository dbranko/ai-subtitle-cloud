# Subtitle fixtures

Representative SRT files used by the automated tests. They are byte-exact
(`*.srt -text` in `.gitattributes`): do not let an editor "fix" them.

| File                  | What it covers                                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `basic-movie.srt`     | Clean, standard dialogue (12 cues), idiom, character name                                                                                                |
| `formatting.srt`      | `<i>` `<b>` `<u>` `<font>`, `{\an8}`, speaker labels, sound descriptions, music, dialogue dashes, position settings, symbol-only cues                    |
| `messy.srt`           | UTF-8 BOM, CRLF, `.` millisecond separator, missing index, missing blank line, extra blank lines, blank line inside a cue, trailing spaces, leading junk |
| `cyrillic-source.srt` | Serbian Cyrillic source including all digraph letters (Љ, Њ, Џ)                                                                                          |
| `legacy-cp1250.srt`   | Windows-1250 encoded Croatian text (not valid UTF-8)                                                                                                     |
| `long-episode.srt`    | 130 cues in scenes separated by time gaps; used for segmentation and long-job tests                                                                      |
