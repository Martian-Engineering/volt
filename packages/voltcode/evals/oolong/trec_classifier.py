#!/usr/bin/env python3
"""
TREC Coarse Question Classifier for OOLONG benchmark.

Classifies general-knowledge questions into 6 TREC coarse categories:
  abbreviation, entity, description and abstract concept,
  human being, location, numeric value

Based on the standard TREC QA taxonomy (Li & Roth, 2002).
Calibrated against the full TREC QA labeled dataset (5952 questions).

Usage:
  python3 trec_classifier.py <input_file> [output_json]

Input: file with lines like "Date: ... || User: ... || Instance: <question>"
Output: JSON with label counts and per-question classifications.
"""

import re
import json
import sys


def classify_trec_coarse(question: str) -> str:
    """Classify a question into one of 6 TREC coarse categories.

    The TREC coarse taxonomy classifies questions by what their ANSWER is:
    - abbreviation: the answer is an abbreviation/acronym expansion
    - entity: the answer is a concrete thing (product, animal, event, etc.)
    - description and abstract concept: the answer is a definition/explanation/reason
    - human being: the answer is a person
    - location: the answer is a place
    - numeric value: the answer is a number, date, or quantity
    """
    q = question.strip().rstrip("?").strip()
    q_lower = q.lower()
    words = q_lower.split()
    if not words:
        return "entity"

    first_word = words[0]

    # ===== ABBREVIATION =====
    if re.search(r'\bstand[s]?\s+for\b', q_lower):
        return "abbreviation"
    if re.search(r'\babbreviation\b|\bacronym\b|\bshort for\b|\binitials of\b', q_lower):
        return "abbreviation"
    # "What is the full form of..."
    if re.search(r'\bfull form of\b', q_lower):
        return "abbreviation"
    # "What does ABC mean?" where ABC is all-caps 2-6 letters
    if re.search(r'what\s+(?:does|do|is|are)\s+[A-Z]{2,6}\b', question):
        if re.search(r'\bmean\b|\bstand\b', q_lower):
            return "abbreviation"
    # "What is ABC?" where ABC is all-caps (likely asking for expansion)
    if re.search(r'^what\s+(?:is|are)\s+[A-Z]{2,6}\s*\??$', question.strip()):
        return "abbreviation"

    # ===== NUMERIC VALUE =====
    # "How many/much/old/long/far/fast/tall/big/high/wide/deep/heavy..."
    if re.search(r'^how\s+(many|much|old|long|far|fast|tall|big|high|wide|deep|heavy|large|hot|cold|often|frequently|early|late|soon|close|hard|expensive|cheap|thick|thin|short|slow|young|small|great|popular|likely|common)', q_lower):
        return "numeric value"
    # "When..." questions
    if first_word == "when":
        return "numeric value"
    # "What year/date/time/age/..." (asking for a number)
    if re.search(r'^what\s+(year|date|time|age|month|day|century|decade|percentage|number|amount|price|fraction|temperature|speed|rate|distance|height|weight|size|diameter|population|score)\b', q_lower):
        return "numeric value"
    # "In what year/month..."
    if re.search(r'^in\s+what\s+(year|month|century|decade)\b', q_lower):
        return "numeric value"
    # "What is the population/price/cost/..." (answer is a number)
    if re.search(r'(?:what|how)\s+(?:is|are|was|were|\'s)\s+(?:the\s+)?(?:population|price|cost|distance|speed|age|height|weight|area|volume|size|number|amount|temperature|diameter|length|width|depth|percentage|average|total|minimum|maximum|record|GNP|salary|wage|rate|odds|probability|chance|fine|fee|toll|penalty|per-capita|mean\s+income|telephone\s+number|phone\s+number|zip\s*code|postal\s*code|atomic\s+(?:number|weight|mass))', q_lower):
        return "numeric value"
    # "What is the highest/lowest/largest number..."
    if re.search(r'(?:highest|lowest|largest|smallest|most|least|longest|shortest|fastest|slowest|greatest|fewest)\s+(?:number|amount|percentage|rate|score|count|quantity|degree|level)', q_lower):
        return "numeric value"
    # "What percent/percentage..."
    if re.search(r'^what\s+percent', q_lower):
        return "numeric value"
    # "What is the life span/expectancy..."
    if re.search(r'life\s+(?:span|expectancy)', q_lower):
        return "numeric value"
    # "What is the regular price?"
    if re.search(r'(?:regular|normal|standard|retail|wholesale|market)\s+price', q_lower):
        return "numeric value"
    # "What does ... cost" / "What is ... worth"
    if re.search(r'\bcost\b|\bworth\b|\bweigh\b', q_lower) and re.search(r'^(?:what|how)', q_lower):
        return "numeric value"
    # "What is the chromosome number / melting point / boiling point..."
    if re.search(r'(?:chromosome|melting|boiling|freezing)\s+(?:number|point)', q_lower):
        return "numeric value"
    # "What is the protection rate / success rate / survival rate..."
    if re.search(r'\b\w+\s+rate\b', q_lower) and re.search(r'^what\b', q_lower):
        return "numeric value"

    # ===== HUMAN BEING =====
    # NOTE: In TREC coarse, HUM includes both individuals AND groups/organizations/companies.
    # "Who..." questions (nearly always human being in TREC)
    if first_word == "who" or first_word == "whom":
        return "human being"
    # Person roles (individual)
    _person_roles = (
        r'person|man|woman|people|guy|girl|boy|lady|gentleman|'
        r'actor|actress|author|writer|poet|novelist|playwright|journalist|reporter|'
        r'president|king|queen|emperor|empress|prince|princess|dictator|chancellor|premier|'
        r'prime\s+minister|first\s+lady|vice\s+president|'
        r'leader|general|admiral|colonel|commander|captain|lieutenant|'
        r'scientist|inventor|explorer|philosopher|mathematician|physicist|chemist|biologist|'
        r'painter|artist|sculptor|composer|musician|singer|conductor|'
        r'director|producer|filmmaker|photographer|architect|designer|'
        r'surgeon|doctor|physician|nurse|psychologist|psychiatrist|'
        r'lawyer|judge|attorney|justice|sheriff|detective|'
        r'criminal|killer|murderer|thief|gangster|outlaw|pirate|'
        r'saint|prophet|pope|cardinal|bishop|monk|rabbi|priest|minister|missionary|'
        r'governor|senator|congressman|mayor|ambassador|diplomat|'
        r'astronaut|cosmonaut|pilot|aviator|'
        r'coach|manager|player|athlete|boxer|wrestler|golfer|swimmer|runner|quarterback|pitcher|catcher|'
        r'champion|winner|olympian|medalist|'
        r'billionaire|founder|CEO|mogul|tycoon|magnate|entrepreneur|'
        r'celebrity|star|comedian|humorist|clown|entertainer|'
        r'hero|heroine|villain|spy|bounty\s+hunter|cowboy|'
        r'scoundrel|martyr|genius|prodigy|pioneer|visionary'
    )
    # Group/organization roles (TREC classifies these as HUM:gr)
    _group_roles = (
        r'team|company|companies|corporation|corporations|firm|firms|'
        r'organization|organizations|group|groups|band|bands|'
        r'agency|agencies|department|departments|bureau|bureaus|'
        r'club|clubs|army|navy|league|association|institute|institution|'
        r'manufacturer|manufacturers|publisher|publishers|supplier|suppliers|'
        r'airline|airlines|carrier|carriers|ISP|ISPs|'
        r'church|churches|sect|sects|cult|cults|tribe|tribes|'
        r'party|parties|government|governments|regime|regimes'
    )
    _all_human_roles = _person_roles + r'|' + _group_roles
    if re.search(r'^(?:what|which|name)\s+(?:the\s+)?(' + _all_human_roles + r')\b', q_lower):
        return "human being"
    # "What is the name of the ..." when it implies a person or group
    if re.search(r'(?:what|who)\s+(?:is|was|were|are)\s+(?:the\s+)?(?:name\s+of\s+)?(?:the\s+)?(?:' + _all_human_roles + r')\b', q_lower):
        return "human being"
    if re.search(r'\bname\s+of\s+(?:the\s+)?(?:first|last|oldest|youngest|tallest|shortest|richest|famous|infamous|notorious)?\s*(?:' + _all_human_roles + r')\b', q_lower):
        return "human being"
    # "Name <N> famous ..."
    if re.search(r'^name\s+(?:\d+\s+)?(?:famous\s+)?(?:' + _all_human_roles + r')', q_lower):
        return "human being"
    # "What famous communist/... leader died/was born..."
    if re.search(r'(?:famous|notorious|legendary|celebrated|infamous)\s+(?:\w+\s+){0,2}(?:' + _all_human_roles + r')', q_lower):
        return "human being"
    # "What is the occupation/profession of..."
    if re.search(r'\b(?:occupation|profession|job)\s+(?:of|is)\b', q_lower):
        return "human being"
    if re.search(r'\bname\s+of\s+(?:the\s+)?(?:\w+\s+){0,3}(?:managing\s+director|director|CEO|chairman|head|chief|boss|leader|manager|coach|captain)\b', q_lower):
        return "human being"
    # "Name the scar-faced X" / "Name <adj> <noun>" patterns for individuals
    if re.search(r'^name\s+(?:the\s+|a\s+|an\s+)?\w+[\s-]+\w+', q_lower):
        # "Name" + stuff — in TREC this is often HUM:ind when not location/entity
        # Check it's not a place or thing
        if not re.search(r'\b(city|cities|state|states|country|countries|nation|continent|ocean|sea|river|lake|mountain|desert|island|region|place|planet|building|bridge|tower|park|valley|volcano)\b', q_lower):
            return "human being"
    # "What <decade/year> <role> ..." e.g. "What 1920s cowboy star..."
    if re.search(r'^what\s+\d{4}s?\s+\w+\s+(star|cowboy|hero|painter|writer|singer|actor)\b', q_lower):
        return "human being"
    # "What <adj> <role> ..." e.g. "What 19th-century painter..."
    if re.search(r'^what\s+[\w-]+\s+(' + _person_roles + r')\b', q_lower):
        return "human being"
    # "Which company/team/..." patterns
    if re.search(r'^which\s+(' + _all_human_roles + r')\b', q_lower):
        return "human being"
    # "What company's/team's logo/product/..."
    if re.search(r"^what\s+(?:" + _group_roles + r")(?:'s|\s)", q_lower):
        return "human being"

    # ===== LOCATION =====
    # "Where..." questions
    if first_word == "where":
        return "location"
    _place_words = (
        r'city|cities|state|states|country|countries|nation|nations|continent|continents|'
        r'ocean|oceans|sea|seas|river|rivers|lake|lakes|mountain|mountains|desert|deserts|'
        r'island|islands|'
        r'region|area|province|county|district|territory|'
        r'place|planet|planets|hemisphere|'
        r'street|address|building|buildings|bridge|bridges|tower|towers|dam|canal|tunnel|'
        r'airport|port|harbor|bay|gulf|strait|peninsula|cape|'
        r'park|garden|zoo|monument|memorial|'
        r'valley|plateau|plain|plains|forest|jungle|cave|volcano|waterfall|waterfalls'
    )
    # "In what city/state/country..."
    if re.search(r'^in\s+what\s+(' + _place_words + r')\b', q_lower):
        return "location"
    if re.search(r'^in\s+which\s+(' + _place_words + r')\b', q_lower):
        return "location"
    # "What city/state/country..."
    if re.search(r'^what\s+(' + _place_words + r')\b', q_lower):
        return "location"
    if re.search(r'^which\s+(' + _place_words + r')\b', q_lower):
        return "location"
    # "What is the capital of..."
    if re.search(r'\bcapital\s+of\b', q_lower):
        return "location"
    # Superlative + place word: "What is the highest waterfall/largest country..."
    if re.search(r'(?:largest|biggest|smallest|highest|lowest|tallest|deepest|longest|nearest|closest|'
                 r'northernmost|southernmost|easternmost|westernmost|most\s+populous|least\s+populous)\s+'
                 r'(' + _place_words + r')\b', q_lower):
        return "location"
    # "What/which <place-word> ..."
    if re.search(r'^(?:what|which)\s+(?:two\s+|three\s+|four\s+)?(' + _place_words + r')\b', q_lower):
        return "location"
    # "What <adj> <place-word> ..." e.g. "What sprawling U.S. state...", "What U.S. state..."
    if re.search(r'^what\s+(?:[\w.-]+\s+){0,2}(' + _place_words + r')\b', q_lower):
        return "location"
    # "What body of water..."
    if re.search(r'\bbody\s+of\s+water\b', q_lower):
        return "location"
    # "Name a/the ... city/country/..." (place names)
    if re.search(r'^name\s+(?:a\s+|the\s+|an\s+)?(?:\w+\s+){0,2}(' + _place_words + r')\b', q_lower):
        return "location"
    # "What is the nickname for the state of..." (answer is a place name/descriptor)
    if re.search(r'\bnickname\s+(?:of|for)\s+(?:the\s+)?(?:' + _place_words + r')\b', q_lower):
        return "location"
    # "What are the world's four oceans" / "What are the names of ... in <place>"
    if re.search(r'\b(?:names?\s+of\s+(?:the\s+)?(?:tourist|major|famous|important)?\s*(?:attractions?|sites?|landmarks?|places?))', q_lower):
        return "location"
    # "What two/three South American/European countries..."
    if re.search(r'\b(?:south\s+american|european|african|asian|north\s+american|latin\s+american)\s+(' + _place_words + r')\b', q_lower):
        return "location"

    # ===== DESCRIPTION AND ABSTRACT CONCEPT =====
    # "Why..." questions (asking for a reason/explanation)
    if first_word == "why":
        return "description and abstract concept"
    # "How do/does/can/should..." (asking for a process/method)
    if re.search(r'^how\s+(do|does|did|can|could|should|would|is|are|was|were)\b', q_lower):
        return "description and abstract concept"
    # Remaining "How..." that isn't numeric (already caught above)
    if first_word == "how":
        return "description and abstract concept"
    # "What does X mean?" (not abbreviations - already caught)
    if re.search(r'\bwhat\s+(?:does|do)\s+.+\s+mean\b', q_lower):
        return "description and abstract concept"
    # "What is the definition/meaning of..."
    if re.search(r'\bdefinition\b|\bmeaning\s+of\b', q_lower):
        return "description and abstract concept"
    # "What causes/caused..."
    if re.search(r'^what\s+(?:causes?|caused)\b', q_lower):
        return "description and abstract concept"
    # "What is the difference between..."
    if re.search(r'\bdifference\s+between\b', q_lower):
        return "description and abstract concept"
    # "What did X do?" / "What did X deal with?" / "What happened..."
    if re.search(r'^what\s+did\b', q_lower):
        return "description and abstract concept"
    # "What do X eat/have/wear?" → entity (answer is a concrete thing)
    if re.search(r'^what\s+(?:do|does|did)\b.*\b(eat|have|wear|drink|produce|grow|make|build|manufacture|play|use|drive|ride|carry|collect)\b', q_lower):
        return "entity"
    # "What do ... believe/think/..." → description
    if re.search(r'^what\s+do\b', q_lower):
        return "description and abstract concept"
    # "What does X symbolize/represent/mean/signify..." → description
    if re.search(r'^what\s+does\b.*\b(symbolize|represent|signify|mean|cause|do)\b', q_lower):
        return "description and abstract concept"
    # "What makes..." (reason/explanation)
    if re.search(r'^what\s+makes?\b', q_lower):
        return "description and abstract concept"
    # "What is X made of?" → entity (answer is a substance/material)
    if re.search(r'\bmade\s+(?:of|from|out\s+of)\b', q_lower) and re.search(r'^what\b', q_lower):
        return "entity"
    # "What is the purpose/function/role/effect/result..."
    if re.search(r'\b(?:purpose|function|role|effect|result|cause|reason|origin|history|significance|meaning|motto|slogan)\s+of\b', q_lower):
        return "description and abstract concept"
    # "What is a fear of X?" / "What is a group of X called?" → entity (specific thing/term)
    if re.search(r'^what\s+(?:is|are)\s+(?:a|an)\s+(?:fear|phobia|group)\s+of\b', q_lower):
        return "entity"
    # "What is X called?" → entity (asking for a name/term)
    if re.search(r'\bcalled\b', q_lower) and re.search(r'^what\b', q_lower):
        return "entity"
    # "What is a <concept>?" — definition questions (but not when asking for a specific thing)
    if re.search(r'^what\s+(?:is|are)\s+(?:a|an)\s+', q_lower):
        return "description and abstract concept"
    # "What is <proper noun>?" where it's asking about the thing itself -> entity
    # "What is the X?" - this is the hardest: could be entity or description
    # In TREC, "What is the X?" tends toward entity when X is a specific named thing
    # and description when X is an abstract concept
    if re.search(r'^what\s+(?:is|are|was|were)\s+the\s+', q_lower):
        remainder = re.sub(r'^what\s+(?:is|are|was|were)\s+the\s+', '', q_lower).strip()
        # If asking about a named/specific thing -> entity
        # Historical events, products, movies, etc.
        if re.search(r'^(?:name|nickname|title|first|last|second|third|only|official|original|real|proper|scientific|technical|common|full|correct|main|primary|oldest|newest|latest|most|least)\b', remainder):
            return "entity"
        # "What is the most ... <noun>?" — often entity
        if re.search(r'^most\s+(?:common|famous|popular|expensive|valuable|powerful|important|dangerous|deadly|poisonous)\b', remainder):
            return "entity"
        # Default for "What is the X?" — lean toward entity
        # This is a probabilistic choice: in TREC, "What is the X?" is more often entity than description
        return "entity"
    # "What is X?" (no article) — often about a specific thing
    if re.search(r'^what\s+(?:is|are|was|were)\s+', q_lower):
        # Check if X starts with a proper noun (capitalized word that's not first word)
        remainder = re.sub(r'^What\s+(?:is|are|was|were)\s+', '', question).strip()
        if remainder and remainder[0].isupper():
            # Proper noun — more likely entity
            return "entity"
        return "description and abstract concept"

    # ===== ENTITY (default) =====
    return "entity"


def parse_file(filepath: str) -> list[tuple[str, str]]:
    """Parse OOLONG data file, returning (question, label) pairs."""
    results = []
    with open(filepath, 'r') as f:
        for line in f:
            m = re.search(r'Instance:\s*(.+)', line)
            if m:
                question = m.group(1).strip()
                label = classify_trec_coarse(question)
                results.append((question, label))
    return results


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 trec_classifier.py <input_file> [output_json]", file=sys.stderr)
        sys.exit(1)

    input_file = sys.argv[1]
    output_json = sys.argv[2] if len(sys.argv) > 2 else None

    results = parse_file(input_file)

    counts = {}
    for _, label in results:
        counts[label] = counts.get(label, 0) + 1

    print(f"Total questions: {len(results)}")
    print(f"\nLabel counts:")
    for label in sorted(counts, key=counts.get, reverse=True):
        print(f"  {label}: {counts[label]}")

    if output_json:
        output = {
            "total": len(results),
            "counts": counts,
            "classifications": [{"question": q, "label": l} for q, l in results]
        }
        with open(output_json, 'w') as f:
            json.dump(output, f, indent=2)
        print(f"\nSaved to {output_json}")


if __name__ == "__main__":
    main()
