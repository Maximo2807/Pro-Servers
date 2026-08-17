// database/migrations/2026_08_16_000001_create_plans_table.php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void {
        Schema::create('plans', function (Blueprint $table) {
            $table->id();
            $table->string('slug')->unique(); // redstone, hierro, oro, diamante, netherite, ghost-warrior, enterprise
            $table->string('name');
            $table->decimal('price_monthly', 8, 2);
            $table->integer('ram_gb');
            $table->integer('max_players'); // -1 = ilimitado
            $table->integer('max_servers'); // ranuras permitidas
            $table->boolean('has_file_manager')->default(false);
            $table->boolean('has_cloud_backups')->default(false);
            $table->boolean('has_ai_diagnostics')->default(false);
            $table->boolean('is_active')->default(true);
            $table->timestamps();
        });
    }

    public function down(): void {
        Schema::dropIfExists('plans');
    }
};