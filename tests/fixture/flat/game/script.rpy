# One file, straight in game/, and a BOM at the front of it.

define mara = Character("Mara", color="#ffb2b2")
# Text messages from the same people, as a separate set of variables.
define mara_msg = Character("Mara", color="#b2d8ff")
define ivo_msg = Character("Ivo", color="#b2d8ff")
define tess_msg = Character("Tess", color="#b2d8ff")
define opal_msg = Character("Opal", color="#b2d8ff")
define rune_msg = Character("Rune", color="#b2d8ff")
define sage_msg = Character("Sage", color="#b2d8ff")
define wren_msg = Character("Wren", color="#b2d8ff")

label start:
    mara "One file, straight in game/."
    "A narrator line."
    mara_msg "On my way."
    mara happy "That is the whole thing."
    return
