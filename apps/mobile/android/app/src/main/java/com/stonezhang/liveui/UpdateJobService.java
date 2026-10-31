package com.stonezhang.liveui;

import android.app.job.JobParameters;
import android.app.job.JobService;
import java.util.concurrent.ConcurrentHashMap;

public final class UpdateJobService extends JobService {
    private final ConcurrentHashMap<Integer, AppUpdater.CheckControl> controls = new ConcurrentHashMap<>();
    @Override public boolean onStartJob(JobParameters params) {
        final AppUpdater.CheckControl run = new AppUpdater.CheckControl(); controls.put(params.getJobId(), run);
        if (params.getJobId() == AppUpdater.INSTALL_JOB) {
            AppUpdater.installReadyInBackground(this, run, retry -> {
                controls.remove(params.getJobId(), run); if (!run.stopped) jobFinished(params, retry);
            });
        } else {
            AppUpdater.check(this, false, false, () -> {
                controls.remove(params.getJobId(), run); if (!run.stopped) jobFinished(params, false);
            }, run);
        }
        return true;
    }
    @Override public boolean onStopJob(JobParameters params) {
        AppUpdater.CheckControl run = controls.remove(params.getJobId()); if (run != null) run.cancel(); return true;
    }
}
