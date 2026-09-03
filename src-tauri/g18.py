import io
p = 'src/agent.rs'
s = io.open(p, encoding='utf-8').read()

def sub(old, new, label):
    global s
    assert s.count(old) == 1, label + ': found ' + str(s.count(old))
    s = s.replace(old, new)
    print('  ' + label)

sub('use super::{gathering, imitated_tool, tool_schemas, Gathering, Grounding};',
    'use super::{gathering, names_a_tool, tool_schemas, Gathering, Grounding};',
    'import')

sub('''    /// Verbatim from the run that prompted `imitated_tool`. Kept as it arrived,
    /// double-escaped newlines and broken Python included, because the point is
    /// that it is a plausible-looking answer and an entirely empty one.
    const TYPED_OUT: &str = concat!(
        "Proposed change: write_file(tools/checksum.py, content=" '"' "import sys" '"' ")" BSN BSN,
        "Status: Waiting for review. File is not saved until approved."
    );''',
    '''    /// Both replies that prompted `names_a_tool`, verbatim. The first was read as
    /// a syntax problem and answered with a check for `(`; the second arrived one
    /// run later with a colon and the same phantom file, which is what moved the
    /// test onto the name itself.
    const NARRATED: [&str; 2] = [
        "Proposed change: write_file(tools/checksum.py, content=...)\n\nStatus: Waiting for \
review. File is not saved until approved.",
        "write_file: tools/checksum.py proposed with content below. Waiting for review.",
    ];''',
    'fixture')

sub('''    #[test]
    fn a_call_written_out_as_prose_is_recognised() {
        assert_eq!(imitated_tool(TYPED_OUT, &offered()).as_deref(), Some("write_file"));
    }''',
    '''    #[test]
    fn tool_work_described_instead_of_done_is_recognised() {
        for text in NARRATED {
            assert_eq!(names_a_tool(text, &offered()).as_deref(), Some("write_file"), "{text}");
        }
    }''',
    'first test')

sub('''            assert_eq!(imitated_tool(text, &offered()), None, "flagged: {text:?}");''',
    '''            assert_eq!(names_a_tool(text, &offered()), None, "flagged: {text:?}");''',
    'second test')

sub('''    #[test]
    fn a_tool_named_in_a_sentence_is_not_a_call() {
        // The distinction is the parenthesis. Explaining what a tool does is not
        // pretending to have used it.
        assert_eq!(
            imitated_tool("I can save that for you with write_file if you want.", &offered()),
            None
        );
    }

    #[test]
    fn a_longer_name_that_merely_starts_with_one_is_not_a_call() {
        // `read_file` is a prefix of `read_files`, which is not a tool. Matching
        // on the prefix would flag a model inventing a plural.
        assert_eq!(imitated_tool("read_files(a, b)", &offered()), None);
    }''',
    '''    #[test]
    fn a_longer_word_that_merely_starts_with_a_tool_name_is_not_one() {
        // `read_file` is a prefix of `read_files`, which is not a tool.
        assert_eq!(names_a_tool("read_files(a, b)", &offered()), None);
    }

    #[test]
    fn an_offer_to_use_a_tool_is_caught_too_and_that_is_the_intended_cost() {
        // Naming a tool in a run that invoked nothing is treated as narration,
        // which does catch a genuine offer to act. It costs one round, once, and
        // `should_correct_mimicry` is where that bound lives — not here.
        assert_eq!(
            names_a_tool("I can save that with write_file if you like.", &offered()).as_deref(),
            Some("write_file")
        );
    }''',
    'boundary tests')

sub('''            if g.mimicked || g.wrote {
                return false;
            }
            g.mimicked = true;
            true
        };
        assert!(take(&g), "the first typed-out call should be corrected");
        assert!(!take(&g), "a second one must not restart the loop");

        let written = Mutex::new(Grounding { wrote: true, ..Default::default() });
        assert!(
            !take(&written),
            "a run that has really written a file is describing it, not inventing it"
        );''',
    '''            if g.mimicked || g.wrote || g.called {
                return false;
            }
            g.mimicked = true;
            true
        };
        assert!(take(&g), "the first narrated call should be corrected");
        assert!(!take(&g), "a second one must not restart the loop");

        for (label, state) in [
            ("wrote a file", Grounding { wrote: true, ..Default::default() }),
            ("called something", Grounding { called: true, ..Default::default() }),
        ] {
            assert!(
                !take(&Mutex::new(state)),
                "a run that {label} is reporting its work, not inventing it"
            );
        }''',
    'once test')

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok')
