package com.stonezhang.liveui;

import android.app.job.JobParameters;
import android.app.job.JobService;

public final class UpdateJobService extends JobService {
    private AppUpdater.CheckControl control;
    @Override public boolean onStartJob(JobParameters params) {
        AppUpdater.schedule(this); final AppUpdater.CheckControl run = new AppUpdater.CheckControl(); control = run;
        AppUpdater.check(this, false, false, () -> { if (!run.stopped) jobFinished(params, false); }, run);
        return true;
    }
    @Override public boolean onStopJob(JobParameters params) { if (control != null) control.cancel(); return true; }
}
