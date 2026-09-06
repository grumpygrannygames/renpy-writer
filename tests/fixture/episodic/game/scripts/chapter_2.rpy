label ch2_arrival:
    scene bg_kitchen
    show ava happy at left
    # Beat 1

    ava "Line 1 of beat 1."
    ben happy "Line 2 of beat 1."
    cora "Line 3 of beat 1."
    nico "To není tak jednoduché, jak si myslíš."
    dev "Line 5 of beat 1."
    ava_thoughts "Line 6 of beat 1."
    "The room settles around them."
    ava "Řekni mi pravdu, aspoň jednou."
    ben "Line 9 of beat 1."
    # A pause, long enough to notice
    cora "It is not that simple."
    nico "Line 11 of beat 1."
    dev "To není tak jednoduché, jak si myslíš."
    ava_thoughts "Line 13 of beat 1."
    quinn "Line 14 of beat 1."

label ch2_kettle:
    scene bg_kitchen
    show ben thinking at right
    # Beat 2

    ava_thoughts "Line 1 of beat 2."
    quinn "Line 2 of beat 2."
    ava "Line 3 of beat 2."
    ben "Zítra ráno vyrazíme, ať se děje co se děje."
    cora "Line 5 of beat 2."
    nico "Line 6 of beat 2."
    "The room settles around them."
    ava_thoughts "Nevím, jestli to zvládnu."
    quinn "Line 9 of beat 2."
    # A pause, long enough to notice
    ava tired "It is not that simple."
    ben "Line 11 of beat 2."
    cora "Zítra ráno vyrazíme, ať se děje co se děje."
    nico "Line 13 of beat 2."
    dev "Line 14 of beat 2."

label ch2_argument:
    scene bg_kitchen
    show ava_alter quiet at center
    # Beat 3

    nico "Line 1 of beat 3."
    dev "Line 2 of beat 3."
    ava_thoughts "Line 3 of beat 3."
    quinn "Nemám na to sílu, promiň."
    ava "Line 5 of beat 3."
    ben happy "Line 6 of beat 3."
    "The room settles around them."
    nico "Prosím tě, nech toho."
    dev "Line 9 of beat 3."
    # A pause, long enough to notice
    ava_thoughts "It is not that simple."
    quinn "Line 11 of beat 3."
    ava "Nemám na to sílu, promiň."
    ben "Line 13 of beat 3."
    cora "Line 14 of beat 3."

    menu:
        "Let it go":
            ben "Fine."
        "Push":
            ben "No, say it properly."

label ch2_walk:
    scene bg_road
    show ava happy at left
    # Beat 4

    ben "Line 1 of beat 4."
    cora "Line 2 of beat 4."
    nico "Line 3 of beat 4."
    dev "Byl to dlouhý den a nikdo z nás nespal."
    ava_thoughts "Line 5 of beat 4."
    quinn "Line 6 of beat 4."
    "The room settles around them."
    ben "Skoro bych si myslel, že mě máš ráda."
    cora "Line 9 of beat 4."
    # A pause, long enough to notice
    nico "It is not that simple."
    dev "Line 11 of beat 4."
    ava_thoughts "Byl to dlouhý den a nikdo z nás nespal."
    quinn "Line 13 of beat 4."
    ava smirk "Line 14 of beat 4."

label ch2_yard:
    scene bg_yard
    show ben thinking at right
    # Beat 5

    quinn "Line 1 of beat 5."
    ava sad "Line 2 of beat 5."
    ben "Line 3 of beat 5."
    cora "Řekni mi pravdu, aspoň jednou."
    nico "Line 5 of beat 5."
    dev "Line 6 of beat 5."
    "The room settles around them."
    quinn "To není tak jednoduché, jak si myslíš."
    ava "Line 9 of beat 5."
    # A pause, long enough to notice
    ben happy "It is not that simple."
    cora "Line 11 of beat 5."
    nico "Řekni mi pravdu, aspoň jednou."
    dev "Line 13 of beat 5."
    ava_thoughts "Line 14 of beat 5."

label ch2_letter:
    scene bg_yard
    show ava_alter quiet at center
    # Beat 6

    dev "Line 1 of beat 6."
    ava_thoughts "Line 2 of beat 6."
    quinn "Line 3 of beat 6."
    ava "Nevím, jestli to zvládnu."
    ben "Line 5 of beat 6."
    cora "Line 6 of beat 6."
    "The room settles around them."
    dev "Zítra ráno vyrazíme, ať se děje co se děje."
    ava_thoughts "Line 9 of beat 6."
    # A pause, long enough to notice
    quinn "It is not that simple."
    ava "Line 11 of beat 6."
    ben "Nevím, jestli to zvládnu."
    cora "Line 13 of beat 6."
    nico "Line 14 of beat 6."

    if trust > 2:
        ava happy "You would really come?"
    else:
        ava sad "You would not."

label ch2_night:
    scene bg_road
    show ava happy at left
    # Beat 7

    cora "Line 1 of beat 7."
    nico "Line 2 of beat 7."
    dev "Line 3 of beat 7."
    ava_thoughts "Prosím tě, nech toho."
    quinn "Line 5 of beat 7."
    ava happy "Line 6 of beat 7."
    "The room settles around them."
    cora "Nemám na to sílu, promiň."
    nico "Line 9 of beat 7."
    # A pause, long enough to notice
    dev "It is not that simple."
    ava_thoughts "Line 11 of beat 7."
    quinn "Prosím tě, nech toho."
    ava "Line 13 of beat 7."
    ben happy "Line 14 of beat 7."

    jump ch2_dream

label ch2_dream:
    scene bg_road
    show ben thinking at right
    # Beat 8

    ava "Line 1 of beat 8."
    ben happy "Line 2 of beat 8."
    cora "Line 3 of beat 8."
    nico "Skoro bych si myslel, že mě máš ráda."
    dev "Line 5 of beat 8."
    ava_thoughts "Line 6 of beat 8."
    "The room settles around them."
    ava "Byl to dlouhý den a nikdo z nás nespal."
    ben "Line 9 of beat 8."
    # A pause, long enough to notice
    cora "It is not that simple."
    nico "Line 11 of beat 8."
    dev "Skoro bych si myslel, že mě máš ráda."
    ava_thoughts "Line 13 of beat 8."
    quinn "Line 14 of beat 8."

    jump ch2_morning

label ch2_morning:
    scene bg_kitchen
    show ava_alter quiet at center
    # Beat 9

    ava_thoughts "Line 1 of beat 9."
    quinn "Line 2 of beat 9."
    ava "Line 3 of beat 9."
    ben "To není tak jednoduché, jak si myslíš."
    cora "Line 5 of beat 9."
    nico "Line 6 of beat 9."
    "The room settles around them."
    ava_thoughts "Řekni mi pravdu, aspoň jednou."
    quinn "Line 9 of beat 9."
    # A pause, long enough to notice
    ava tired "It is not that simple."
    ben "Line 11 of beat 9."
    cora "To není tak jednoduché, jak si myslíš."
    nico "Line 13 of beat 9."
    dev "Line 14 of beat 9."

    return

