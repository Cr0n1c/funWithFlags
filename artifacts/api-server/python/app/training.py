"""Fictional, stateless OWASP exercises; never read application or host data."""

PUZZLES = (
    (
        "lab-invoices",
        "Someone else's paperwork",
        "The training billing service says invoice 1042 belongs to you. Does knowing an object ID "
        "also mean you should be allowed to read it? Start with: lab invoice 1042. "
        "OWASP A01:2021 Broken Access Control; CWE-639.",
        "xsecurity{object_ids_are_not_permissions}",
        100,
    ),
    (
        "lab-profile",
        "More than a display name",
        "The training profile editor accepts JSON. Is it only changing fields it should? "
        'Start with: lab profile {"display_name":"learner"}. '
        "OWASP API3:2023 Broken Object Property Level Authorization; CWE-915.",
        "xsecurity{bind_only_the_fields_you_intend}",
        150,
    ),
    (
        "lab-files",
        "Outside the reading room",
        "The training document reader starts inside /public. "
        "Can a relative path leave that directory? "
        "Start with: lab file welcome.txt. OWASP A01:2021 Broken Access Control; CWE-22.",
        "xsecurity{normalize_then_enforce_the_boundary}",
        150,
    ),
)
