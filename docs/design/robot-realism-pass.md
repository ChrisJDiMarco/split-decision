# QUEUED: robot construction realism pass (Chris approved queueing on 2026-10-20)

Start this only after the strike-pass build (src/robots/designs/index.ts, humanoid.ts, catalog.ts)
and the nextgen build (tools/nextgen, tests/nextgen: it locks the modern MJCF that buildHumanoid
produces) have landed. Every item changes the dynamics, so afterwards re-run the drills, gantry and
roster tests (tests/roster, tests/nextgen), and re-lock the fixtures only on purpose.

## 1. Armature from the real drive train (src/robots/humanoid.ts:151)
Today: `armature: 0.02 + motor.massKg * 0.01` (a placeholder). The catalog already carries
rotorInertiaKgM2 × gearRatio², or reflectedInertiaKgM2, and the damage model uses it
(src/physics/damage/durability.ts:176). Use the same value. Examples:
- plan.x12: 0.044 now vs 0.52 real.
- qdd.t800: 0.058 vs 0.24.
- qdd.ake90: 0.034 vs 0.022.
- qdd.rs04: 0.034 vs 0.024.
- qdd.rs06: 0.026 vs 0.005.
- qdd.rs06x2: 0.033 vs 0.0097.
Keep a small floor for solver stability on light links. Check joint-loads.ts subtracts dof_armature, so
the damage numbers stay right.

## 2. Motor mass on the right body (src/robots/compile-mjcf.ts:103, partMotorMass)
Today each joint's motor mass goes into the child part it moves. Real builds fix the stator to the parent,
or mount the drive high and use a linkage. Proposed placement:
- Shoulder pitch: in the torso.
- Elbow: in the upper arm.
- Hip yaw: in the pelvis.
- Knee: in the thigh, with a linkage.
- Ankle drives: in the shin, with a parallel linkage, as on Unitree G1/H1-2 and Optimus.
Today's worst cases:
- HAYMAKER: 4.4 kg of knee motors per shin, 4.7 kg of ankle motors per foot, 11.2 kg of hip motors per thigh.
- SAVATE: 5.8 kg of ankle motors per foot.
Needs a per-joint "mount" (parent | self) in JointDef. The iron-age MJCF is held to the byte
(tests/roster/iron-age.test.ts), so either gate this on era === 'modern' or re-freeze it deliberately.

## 3. Dedicated ankle motor group (src/robots/humanoid.ts:306-307)
Ankle pitch and roll use motors.leg today, so SAVATE and PYLON get 323 N·m on every ankle axis
(~2× what's needed). Add motors.ankle (and optionally ankleRoll), sized ~1.5-2 N·m per kg of body
(qdd.ake90 for the middles, plan.x12 or ake90 for HAYMAKER, ak10 for FIRECRACKER). The modern roster
masses must stay within 1% of docs/research/08-modern-roster.md. Re-balance the shell fill if needed.

## 4. Catalog consistency (src/robots/catalog.ts)
- servo.neck (line ~181): says RobStride 02 but runs at 12 rad/s with different thermal numbers,
  while qdd.rs02 runs at 42.9 rad/s. Either make it the RS02, or name the real slower servo.
- drive.wheel (line ~197): "RobStride 04 direct" has 120 N·m, but that figure includes the 9:1 box.
  A direct hub is ~13 N·m. Either call it geared or fix the torque.

## Reviewed and fine as built
- No wrist joint.
- A yaw-only neck.
- Hip yaw→roll→pitch and shoulder pitch→roll→yaw order.
- Hand flexion axes and the thumb (checked the rotation maths).
- The tendon layout.
- Glove sizing by class.
