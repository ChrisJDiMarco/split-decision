// Move queues for tools/polish/run.ts and measure.ts.
export const QUEUES: Record<string, string[]> = {
  // The five proof-of-concept moves (move-polish.md §9), longest first so it is not the straggler.
  poc: [
    'firecracker/getup_back.140_09.0027',
    'savate/cross.13_17.1024',
    'haymaker/hook.14_03.1228',
    'savate/head_kick.135_07.0016',
    'firecracker/tornado_kick.135_07.0179',
  ],
  // Second pass on the strikes with the sharper cost (torso tilt, end position, impact speed against the
  // actor's peak, slowing penalised harder), then Chris's priority: the back get-ups on the modern designs.
  round2: [
    'savate/cross.13_17.1024@full',
    'savate/head_kick.135_07.0016@full',
    'haymaker/hook.14_03.1228@full',
    'firecracker/tornado_kick.135_07.0179@full',
    'savate/getup_back.140_08.0076@lite',
    'haymaker/getup_back.140_08.0076@lite',
    'pylon/getup_back.140_08.0076@lite',
    'firecracker/getup_back.140_08.0076@lite',
    'savate/getup_back.140_09.0027@lite',
    'haymaker/getup_back.140_09.0027@lite',
    'pylon/getup_back.140_09.0027@lite',
  ],
  // Everything polished so far (measure.ts / accept.ts).
  final: [
    'savate/cross.13_17.1024',
    'haymaker/hook.14_03.1228',
    'savate/head_kick.135_07.0016',
    'firecracker/getup_back.140_09.0027',
    'firecracker/tornado_kick.135_07.0179',
    'savate/getup_back.140_08.0076',
    'haymaker/getup_back.140_08.0076',
    'pylon/getup_back.140_08.0076',
    'firecracker/getup_back.140_08.0076',
    'savate/getup_back.140_09.0027',
    'haymaker/getup_back.140_09.0027',
    'pylon/getup_back.140_09.0027',
  ],
  backgetup: [
    'savate/getup_back.140_08.0076',
    'haymaker/getup_back.140_08.0076',
    'pylon/getup_back.140_08.0076',
    'firecracker/getup_back.140_08.0076',
    'savate/getup_back.140_09.0027',
    'haymaker/getup_back.140_09.0027',
    'pylon/getup_back.140_09.0027',
  ],
};

